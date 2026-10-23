import {access, mkdir, mkdtemp, rename, rm, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import type {Tool} from '@itookit/tools';
import {copyPackageFiles, packageFiles, packageFingerprint, resolvePackageExecutables, type ExecutableBinding} from './files';
import {packageError, readToolPackage, type ToolPackageSource} from './manifest';
import type {RegisteredToolPackage} from './store';
import {loadNodeToolModules} from '../tool-modules';
import {withPackageEnvironment} from './environment';

export interface InstalledToolPackage {source: ToolPackageSource; registration: RegisteredToolPackage; tools: Tool[];}

export async function restoreToolPackage(directory: string, registration: RegisteredToolPackage): Promise<InstalledToolPackage> {
    const source = await readToolPackage(directory); validateBindings(source, registration.bindings);
    for (const binding of registration.bindings) {
        try {await access(binding.path, constants.X_OK); if (!(await stat(binding.path)).isFile()) throw new Error('not a file');}
        catch {throw packageError('TOOL_PACKAGE_EXECUTABLE_MISSING', `Registered executable ${binding.env} is unavailable; restore its configured executable before retrying`);}
    }
    const files = await packageFiles(source, registration.bindings);
    if (source.manifest.id !== registration.id || source.manifest.version !== registration.version
        || await packageFingerprint(source, files) !== registration.fingerprint)
        throw packageError('TOOL_PACKAGE_CONTENT_CONFLICT', `Installed package ${registration.id}@${registration.version} differs from its registration`);
    return {source, registration, tools: await packageTools(source, registration.bindings)};
}

export async function stageToolPackage(source: ToolPackageSource, directory: string, env: NodeJS.ProcessEnv): Promise<InstalledToolPackage> {
    const resolved = await resolvePackageExecutables(source, env);
    const files = await packageFiles(source, resolved), fingerprint = await packageFingerprint(source, files);
    const parent = path.dirname(directory); await mkdir(parent, {recursive: true});
    const staged = await mkdtemp(path.join(parent, '.install-'));
    try {
        const copied = await copyPackageFiles(source, staged, files, resolved);
        const bindings = copied.map(binding => binding.source === 'package' && binding.relative ? {...binding, path: path.join(directory, binding.relative)} : binding);
        const registration = {id: source.manifest.id, version: source.manifest.version, fingerprint, bindings};
        try {await rename(staged, directory);}
        catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            const installed = await readToolPackage(directory);
            if (await packageFingerprint(installed, await packageFiles(installed, bindings)) !== fingerprint)
                throw packageError('TOOL_PACKAGE_CONTENT_CONFLICT', `Package ${registration.id}@${registration.version} is already installed with different contents`);
        }
        return restoreToolPackage(directory, registration);
    } finally {await rm(staged, {recursive: true, force: true});}
}

function validateBindings(source: ToolPackageSource, bindings: ExecutableBinding[]): void {
    if (bindings.length !== source.manifest.executables.length) throw packageError('TOOL_PACKAGE_REGISTRY_INVALID', 'Executable registration does not match its package manifest');
    for (const executable of source.manifest.executables) {
        const binding = bindings.find(item => item.env === executable.env);
        if (!binding || binding.source === 'package' && (binding.relative !== executable.default || binding.path !== path.join(source.root, executable.default)))
            throw packageError('TOOL_PACKAGE_REGISTRY_INVALID', 'Invalid package executable registration');
    }
}

async function packageTools(source: ToolPackageSource, bindings: ExecutableBinding[]): Promise<Tool[]> {
    return withPackageEnvironment(bindings, async () => {
        const tools = await loadNodeToolModules(JSON.stringify([path.join(source.root, source.manifest.module)]));
        if (tools.length !== source.manifest.tools.length || tools.some(tool => !source.manifest.tools.some(expected => expected.id === tool.name
            && (expected.version === undefined || expected.version === (tool.version ?? '1')))))
            throw packageError('TOOL_PACKAGE_EXPORT_MISMATCH', `Package ${source.manifest.id}@${source.manifest.version} exports tools that differ from its manifest`);
        return tools;
    });
}

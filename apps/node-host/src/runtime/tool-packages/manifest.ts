import {readFile, readdir, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

export interface ToolPackageManifest {
    format: 1; id: string; version: string; name?: string; description?: string;
    module: string; files: string[]; tools: Array<{id: string; version?: string}>;
    executables: Array<{env: string; command: string; default: string}>;
}
export interface ToolPackageSource {root: string; manifest: ToolPackageManifest;}

export function packageError(code: string, message: string): Error & {code: string} {return Object.assign(new Error(message), {code});}
export function packageIdentity(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value) || value === '..')
        throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', `Invalid tool package ${field}`);
    return value;
}
export function packageRelative(value: unknown): string {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')
        || value.split('/').some(part => part === '..' || part === '' || part === '.'))
        throw packageError('TOOL_PACKAGE_PATH_INVALID', 'Tool package entries must use paths inside their package');
    return value;
}

export async function readToolPackage(root: string): Promise<ToolPackageSource> {
    const raw = await readFile(path.join(root, 'nestos-tool.json'), 'utf8'); let data: unknown;
    try {data = JSON.parse(raw);} catch {throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Tool package manifest contains invalid JSON');}
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Expected a tool package manifest');
    const item = data as Record<string, unknown>;
    if (item.format !== 1 || !Array.isArray(item.tools) || !item.tools.length) throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Unsupported or empty tool package manifest');
    const manifest: ToolPackageManifest = {format: 1, id: packageIdentity(item.id, 'id'), version: packageIdentity(item.version, 'version'),
        module: packageRelative(item.module), files: relativeEntries(item.files), tools: toolEntries(item.tools), executables: executableEntries(item.executables),
        ...(typeof item.name === 'string' ? {name: item.name} : {}), ...(typeof item.description === 'string' ? {description: item.description} : {})};
    return {root: await realpath(root), manifest};
}

function relativeEntries(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Expected package files to be an array');
    return [...new Set(value.map(packageRelative))];
}
function toolEntries(value: unknown[]): ToolPackageManifest['tools'] {
    const tools = value.map(entry => {
        const item = typeof entry === 'string' ? {id: entry} : entry as {id?: unknown; version?: unknown};
        if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(item.id)
            || item.id.split('/').some(part => !part || part === '.' || part === '..'))
            throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Invalid package tool identity');
        if (item.version !== undefined && (typeof item.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(item.version)))
            throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Invalid package tool version');
        return {id: item.id, ...(item.version === undefined ? {} : {version: packageIdentity(item.version, 'tool version')})};
    });
    if (new Set(tools.map(tool => tool.id)).size !== tools.length) throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Duplicate tool identity in package manifest');
    return tools;
}
function executableEntries(value: unknown): ToolPackageManifest['executables'] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Expected package executables to be an array');
    const entries = value.map(item => {
        if (!item || typeof item !== 'object' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(item.env)
            || ['HOME', 'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'CODEX_HOME', 'INIT_CWD', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'].includes(item.env)
            || typeof item.command !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(item.command))
            throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Invalid executable binding in tool package');
        return {env: item.env as string, command: item.command as string, default: packageRelative(item.default)};
    });
    if (new Set(entries.map(item => item.env)).size !== entries.length) throw packageError('TOOL_PACKAGE_MANIFEST_INVALID', 'Duplicate executable environment binding');
    return entries;
}

export function toolPackageDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
    if (!env.NESTOS_TOOL_PACKAGE_DIRS) return [path.resolve(env.INIT_CWD || process.cwd(), 'tools')];
    let value: unknown;
    try {value = JSON.parse(env.NESTOS_TOOL_PACKAGE_DIRS);} catch {throw packageError('TOOL_PACKAGE_CATALOG_INVALID', 'NESTOS_TOOL_PACKAGE_DIRS must be a JSON array of absolute directories');}
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !path.isAbsolute(item)))
        throw packageError('TOOL_PACKAGE_CATALOG_INVALID', 'NESTOS_TOOL_PACKAGE_DIRS must be a JSON array of absolute directories');
    return [...new Set(value as string[])];
}

export async function discoverToolPackages(directories: string[]): Promise<ToolPackageSource[]> {
    const sources: ToolPackageSource[] = [];
    for (const directory of directories) {
        try {
            if ((await stat(path.join(directory, 'nestos-tool.json'))).isFile()) {sources.push(await readToolPackage(directory)); continue;}
        } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
        let children;
        try {children = await readdir(directory, {withFileTypes: true});}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
        for (const child of children.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
            try {sources.push(await readToolPackage(path.join(directory, child.name)));}
            catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
        }
    }
    return sources;
}

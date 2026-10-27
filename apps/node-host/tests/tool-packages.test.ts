import {afterEach, expect, it, vi} from 'vitest';
import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ToolDeviceDriver} from '@itookit/tools';
import type {IDeviceDriver} from '@itookit/vfs-core';
import {createKernelAdaptersRuntime} from '@itookit/kernel-adapters';
import {NodeToolPackages} from '../src/runtime/tool-packages';
import {loadNodeToolModules, mergeNodePackageTools} from '../src/runtime/tool-modules';
import {toolPackageDirectories} from '../src/runtime/tool-packages/manifest';

const cleanups: Array<() => Promise<unknown>> = [];
const priorExecutable = process.env.NESTOS_FIXTURE_TOOL_BIN;
afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks();
    if (priorExecutable === undefined) delete process.env.NESTOS_FIXTURE_TOOL_BIN; else process.env.NESTOS_FIXTURE_TOOL_BIN = priorExecutable;
});

async function fixture({id = 'fixture', version = '0.1.0', binary = true, root: parent}: {id?: string; version?: string; binary?: boolean; root?: string} = {}) {
    const root = parent ?? await mkdtemp(path.join(tmpdir(), 'nestos-tool-package-'));
    if (!parent) cleanups.push(() => rm(root, {recursive: true, force: true}));
    const packageRoot = path.join(root, 'catalog', id), node = path.join(packageRoot, 'node');
    await mkdir(node, {recursive: true});
    const toolId = `${id}.convert`, module = path.join(node, 'extension.mjs');
    await writeFile(module, `export function createTools({buildTool,z}) {return [buildTool({name:${JSON.stringify(toolId)},version:'1',isReadOnly:()=>true,
        inputSchema:z.object({value:z.string()}),description:async()=>'Fixture converter',call:async args=>({data:args.value})})]}`);
    const manifest = {format: 1, id, version, module: 'node/extension.mjs', files: ['node'], tools: [{id: toolId, version: '1'}],
        executables: [{env: `NESTOS_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOOL_BIN`, command: 'fixture-cli', default: 'target/release/fixture-cli'}]};
    await writeFile(path.join(packageRoot, 'nestos-tool.json'), JSON.stringify(manifest));
    if (binary) {await mkdir(path.join(packageRoot, 'target/release'), {recursive: true}); await executable(path.join(packageRoot, 'target/release/fixture-cli'));}
    const env = {PATH: '', XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), NESTOS_TOOL_PACKAGE_DIRS: JSON.stringify([path.join(root, 'catalog')])};
    return {root, packageRoot, module, manifest, toolId, env, manager: () => {
        const manager = new NodeToolPackages({env}); cleanups.push(() => manager.close()); return manager;
    }};
}
async function executable(file: string): Promise<void> {await writeFile(file, '#!/bin/sh\nexit 0\n'); await chmod(file, 0o755);}
async function runtime(tools: import('@itookit/tools').Tool[] = []) {
    const instance = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver, additionalTools: tools});
    cleanups.push(() => instance.dispose()); return instance;
}

it('discovers trusted package roots and installs an existing local binary without a build or restart', async () => {
    const f = await fixture(), manager = f.manager(), kernel = await runtime(), active = await kernel.sessions.get('active');
    await manager.initialize(); manager.bind(kernel);
    expect(await manager.list()).toMatchObject([{id: 'fixture', version: '0.1.0', status: 'available'}]);
    const results = await Promise.all([manager.ensure([{id: f.toolId, version: '1'}]), manager.ensure([{id: f.toolId, version: '1'}])]);
    expect(results).toEqual([{tools: [{id: f.toolId, version: '1', status: 'ready'}]}, {tools: [{id: f.toolId, version: '1', status: 'ready'}]}]);
    expect(await active.toolService.invoke({toolId: f.toolId, args: {value: 'hot'}, toolVersion: '1', resultMode: 'structured'})).toMatchObject({success: true, data: 'hot'});
    expect((await kernel.sessions.get('next')).toolService.getToolMeta(f.toolId)?.version).toBe('1');
    const installed = path.join(f.env.XDG_DATA_HOME, 'nestos/tools/fixture/0.1.0');
    expect(await readFile(path.join(installed, 'node/extension.mjs'), 'utf8')).toContain('Fixture converter');
    expect(process.env.NESTOS_FIXTURE_TOOL_BIN).toBe(path.join(installed, 'target/release/fixture-cli'));
    const metadata = JSON.parse(await readFile(path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8'));
    expect(metadata.packages).toHaveLength(1); expect((await manager.list())[0].status).toBe('registered');
});

it('prefers a PATH executable, keeps package contents outside config, and restores durable registration on startup', async () => {
    const f = await fixture({binary: false}), binaries = path.join(f.root, 'bin'); await mkdir(binaries); await executable(path.join(binaries, 'fixture-cli'));
    f.env.PATH = binaries;
    const manager = f.manager(); await manager.initialize(); manager.bind(await runtime()); await manager.ensure([{id: f.toolId, version: '1'}]);
    expect(process.env.NESTOS_FIXTURE_TOOL_BIN).toBe(path.join(binaries, 'fixture-cli'));
    const restored = f.manager(); await restored.initialize();
    const kernel = await runtime(restored.initialTools()); restored.bind(kernel);
    expect(await restored.ensure([{id: f.toolId, version: '1'}])).toEqual({tools: [{id: f.toolId, version: '1', status: 'ready'}]});
    expect(kernel.toolCatalog.getToolMeta(f.toolId)).toMatchObject({version: '1', enabled: true});
    expect(JSON.stringify(await restored.list())).not.toContain(f.packageRoot);
});

it('reuses legacy module instances at the same tool version and never enables a disabled tool', async () => {
    const f = await fixture(), legacy = await loadNodeToolModules(JSON.stringify([f.module]));
    legacy[0].isEnabled = () => false;
    const manager = f.manager(); await manager.initialize(); const kernel = await runtime(legacy); manager.bind(kernel);
    const register = vi.spyOn(kernel, 'registerTools');
    const result = await manager.ensure([{id: f.toolId, version: '1'}]);
    expect(result.tools[0]).toMatchObject({status: 'failed', code: 'TOOL_PACKAGE_TOOL_DISABLED'}); expect(register).not.toHaveBeenCalled();
    expect(kernel.toolCatalog.getToolMeta(f.toolId)?.enabled).toBe(false);
    const restored = await loadNodeToolModules(JSON.stringify([f.module]));
    expect(mergeNodePackageTools(legacy, restored)).toEqual(legacy);
    restored[0].version = '2'; expect(() => mergeNodePackageTools(legacy, restored)).toThrow('conflicting');
});

it('reports missing executables and exact tool version conflicts without invoking arbitrary locations', async () => {
    const f = await fixture({binary: false}), manager = f.manager(); await manager.initialize(); manager.bind(await runtime());
    expect((await manager.ensure([{id: f.toolId, version: '1'}])).tools[0]).toMatchObject({status: 'missing', code: 'TOOL_PACKAGE_EXECUTABLE_MISSING'});
    expect((await manager.ensure([{id: '/tmp/untrusted.mjs', version: '1'}])).tools[0]).toMatchObject({status: 'missing', code: 'TOOL_PACKAGE_NOT_FOUND'});
    const legacy = await loadNodeToolModules(JSON.stringify([f.module])), second = f.manager(); await second.initialize(); second.bind(await runtime(legacy));
    expect((await second.ensure([{id: f.toolId, version: '2'}])).tools[0]).toMatchObject({status: 'failed', code: 'TOOL_PACKAGE_TOOL_VERSION_CONFLICT'});
});

it('rejects escaping package files and preserves an installed version when catalog contents change', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); manager.bind(await runtime());
    await manager.install({id: 'fixture', version: '0.1.0'});
    await writeFile(f.module, 'export function createTools(){return []}');
    await expect(manager.install({id: 'fixture', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_CONTENT_CONFLICT'});
    await expect(manager.install({id: 'fixture', version: '0.2.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_VERSION_CONFLICT'});
    const other = await fixture({id: 'escaping'}); await symlink(f.module, path.join(other.packageRoot, 'node/link.mjs'));
    const unsafe = other.manager(); await unsafe.initialize(); unsafe.bind(await runtime());
    await expect(unsafe.install({id: 'escaping', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_PATH_INVALID'});
    expect(() => toolPackageDirectories({NESTOS_TOOL_PACKAGE_DIRS: '["relative"]'})).toThrow('absolute');
});

it('does not drop sibling registry entries when separate host managers install packages concurrently', async () => {
    const first = await fixture(), second = await fixture({id: 'second', root: first.root});
    const a = first.manager(), b = second.manager(); await Promise.all([a.initialize(), b.initialize()]);
    a.bind(await runtime()); b.bind(await runtime());
    await Promise.all([a.install({id: 'fixture', version: '0.1.0'}), b.install({id: 'second', version: '0.1.0'})]);
    const saved = JSON.parse(await readFile(path.join(first.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8'));
    expect(saved.packages.map((item: {id: string}) => item.id).sort()).toEqual(['fixture', 'second']);
    const restored = first.manager(); await restored.initialize();
    const driver = new ToolDeviceDriver(restored.initialTools()); await driver.init();
    expect(driver.getToolMeta('fixture.convert')).toBeDefined(); expect(driver.getToolMeta('second.convert')).toBeDefined(); await driver.dispose();
});

it('includes copied executable contents in immutable package fingerprints and startup verification', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); manager.bind(await runtime());
    await manager.install({id: 'fixture', version: '0.1.0'});
    await writeFile(path.join(f.packageRoot, 'target/release/fixture-cli'), '#!/bin/sh\nexit 1\n');
    await expect(manager.install({id: 'fixture', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_CONTENT_CONFLICT'});
    const installedBinary = path.join(f.env.XDG_DATA_HOME, 'nestos/tools/fixture/0.1.0/target/release/fixture-cli');
    await writeFile(installedBinary, '#!/bin/sh\nexit 2\n');
    const restored = f.manager(); await restored.initialize();
    expect(restored.initialTools()).toEqual([]);
    expect(await restored.list()).toMatchObject([{status: 'failed', code: 'TOOL_PACKAGE_CONTENT_CONFLICT'}]);
});

it('restores executable environment and registry metadata when runtime registration fails', async () => {
    const f = await fixture(), manager = f.manager(), kernel = await runtime(), previous = process.env.NESTOS_FIXTURE_TOOL_BIN;
    await manager.initialize(); manager.bind(kernel);
    const register = vi.spyOn(kernel, 'registerTools').mockRejectedValueOnce(new Error('private module detail'));
    await expect(manager.install({id: 'fixture', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_REGISTER_FAILED'});
    expect(process.env.NESTOS_FIXTURE_TOOL_BIN).toBe(previous); expect(kernel.toolCatalog.getToolMeta(f.toolId)).toBeUndefined();
    const saved = JSON.parse(await readFile(path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8')); expect(saved.packages).toEqual([]);
    register.mockRestore(); expect((await manager.ensure([{id: f.toolId, version: '1'}])).tools[0].status).toBe('ready');
});

it('rejects conflicting executable bindings before changing an already registered package environment', async () => {
    const first = await fixture(), other = await fixture({id: 'second', root: first.root});
    other.manifest.executables[0].env = first.manifest.executables[0].env;
    await writeFile(path.join(other.packageRoot, 'nestos-tool.json'), JSON.stringify(other.manifest));
    const manager = first.manager(); await manager.initialize(); manager.bind(await runtime());
    await manager.install({id: 'fixture', version: '0.1.0'}); const previous = process.env.NESTOS_FIXTURE_TOOL_BIN;
    await expect(manager.install({id: 'second', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_EXECUTABLE_CONFLICT'});
    expect(process.env.NESTOS_FIXTURE_TOOL_BIN).toBe(previous);
});

it('classifies invalid manifest and registration JSON without including their contents', async () => {
    const f = await fixture(); await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), '{private-malformed-value');
    await expect(f.manager().initialize()).rejects.toMatchObject({code: 'TOOL_PACKAGE_MANIFEST_INVALID', message: 'Tool package manifest contains invalid JSON'});
    await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), JSON.stringify(f.manifest));
    await mkdir(path.join(f.env.XDG_CONFIG_HOME, 'nestos'), {recursive: true});
    await writeFile(path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), '{private-malformed-value');
    await expect(f.manager().initialize()).rejects.toMatchObject({code: 'TOOL_PACKAGE_REGISTRY_INVALID', message: 'Tool package registration metadata contains invalid JSON'});
});

it('serializes registry updates from independent Node processes and preserves both package records', async () => {
    const f = await fixture(), file = path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json');
    const first = registryWorker(file, 'first', 1000); await first.locked;
    const second = registryWorker(file, 'second', 0); await Promise.all([first.done, second.done]);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.packages.map((item: {id: string}) => item.id).sort()).toEqual(['first', 'second']);
});

function registryWorker(file: string, id: string, delay: number) {
    const loader = createRequire(new URL('../../cli/package.json', import.meta.url)).resolve('tsx');
    const worker = fileURLToPath(new URL('./tool-package-registry-worker.mts', import.meta.url));
    const child = spawn(process.execPath, ['--import', loader, worker, file, id, String(delay)], {stdio: ['ignore', 'pipe', 'pipe']});
    cleanups.push(async () => {if (child.exitCode === null) child.kill('SIGKILL');});
    let error = ''; child.stderr.on('data', data => {error += String(data);});
    const done = new Promise<void>((resolve, reject) => {child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error)));});
    const locked = new Promise<void>((resolve, reject) => {child.stdout.once('data', () => resolve()); void done.catch(reject);});
    return {locked, done};
}

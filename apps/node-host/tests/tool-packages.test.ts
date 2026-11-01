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
import {readPackageGuide} from '../src/runtime/tool-packages/guide';
import {toolPackageDirectories} from '../src/runtime/tool-packages/manifest';
import {NodeToolConnections} from '../src/runtime/tool-connections';
import {packageSourceEnvironment} from '../src/runtime/tool-packages/environment';

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
it('imports only registered fingerprinted Flow resources and keeps business definitions in their package', async () => {
    const f = await fixture();
    await mkdir(path.join(f.packageRoot, 'flows'));
    const template = {id: 'external-import', name: 'External import', draftVersion: 1, nodes: [], edges: [], updatedAt: 0};
    await writeFile(path.join(f.packageRoot, 'flows', 'import.flow'), JSON.stringify(template));
    await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), JSON.stringify({...f.manifest, flows: ['flows/import.flow']}));
    const manager = f.manager(); await manager.initialize(); await manager.bind(await runtime());
    expect(await manager.list()).toMatchObject([{flowCount: 1, status: 'available'}]);
    await expect(manager.flowTemplates('fixture', '0.1.0')).rejects.toThrow('Register this package version');
    await manager.ensure([{id: f.toolId, version: '1'}]);
    expect(await manager.flowTemplates('fixture', '0.1.0')).toEqual([{...template, layout: {}}]);
    await expect(manager.flowTemplates('../fixture', '0.1.0')).rejects.toThrow();
    const restarted = f.manager(); await restarted.initialize();
    expect(await restarted.flowTemplates('fixture', '0.1.0')).toEqual([{...template, layout: {}}]);
});
async function runtime(tools: import('@itookit/tools').Tool[] = []) {
    const instance = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver, additionalTools: tools});
    cleanups.push(() => instance.dispose()); return instance;
}

it('discovers trusted package roots and installs an existing local binary without a build or restart', async () => {
    const f = await fixture(), manager = f.manager(), kernel = await runtime(), active = await kernel.sessions.get('active');
    await manager.initialize(); await manager.bind(kernel);
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
    const manager = f.manager(); await manager.initialize(); await manager.bind(await runtime()); await manager.ensure([{id: f.toolId, version: '1'}]);
    expect(process.env.NESTOS_FIXTURE_TOOL_BIN).toBe(path.join(binaries, 'fixture-cli'));
    const restored = f.manager(); await restored.initialize();
    const kernel = await runtime(restored.initialTools()); await restored.bind(kernel);
    expect(await restored.ensure([{id: f.toolId, version: '1'}])).toEqual({tools: [{id: f.toolId, version: '1', status: 'ready'}]});
    expect(kernel.toolCatalog.getToolMeta(f.toolId)).toMatchObject({version: '1', enabled: true});
    expect(JSON.stringify(await restored.list())).not.toContain(f.packageRoot);
});

it('reuses legacy module instances at the same tool version and never enables a disabled tool', async () => {
    const f = await fixture(), legacy = await loadNodeToolModules(JSON.stringify([f.module]));
    legacy[0].isEnabled = () => false;
    const manager = f.manager(); await manager.initialize(); const kernel = await runtime(legacy); await manager.bind(kernel);
    const register = vi.spyOn(kernel, 'registerTools');
    const result = await manager.ensure([{id: f.toolId, version: '1'}]);
    expect(result.tools[0]).toMatchObject({status: 'failed', code: 'TOOL_PACKAGE_TOOL_DISABLED'}); expect(register).not.toHaveBeenCalled();
    expect(kernel.toolCatalog.getToolMeta(f.toolId)?.enabled).toBe(false);
    const restored = await loadNodeToolModules(JSON.stringify([f.module]));
    expect(mergeNodePackageTools(legacy, restored)).toEqual(legacy);
    restored[0].version = '2'; expect(() => mergeNodePackageTools(legacy, restored)).toThrow('conflicting');
});

it('reports missing executables and exact tool version conflicts without invoking arbitrary locations', async () => {
    const f = await fixture({binary: false}), manager = f.manager(); await manager.initialize(); await manager.bind(await runtime());
    expect((await manager.ensure([{id: f.toolId, version: '1'}])).tools[0]).toMatchObject({status: 'missing', code: 'TOOL_PACKAGE_EXECUTABLE_MISSING'});
    expect((await manager.ensure([{id: '/tmp/untrusted.mjs', version: '1'}])).tools[0]).toMatchObject({status: 'missing', code: 'TOOL_PACKAGE_NOT_FOUND'});
    const legacy = await loadNodeToolModules(JSON.stringify([f.module])), second = f.manager(); await second.initialize(); await second.bind(await runtime(legacy));
    expect((await second.ensure([{id: f.toolId, version: '2'}])).tools[0]).toMatchObject({status: 'failed', code: 'TOOL_PACKAGE_TOOL_VERSION_CONFLICT'});
});

it('rejects escaping package files and preserves an installed version when catalog contents change', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); await manager.bind(await runtime());
    await manager.install({id: 'fixture', version: '0.1.0'});
    await writeFile(f.module, 'export function createTools(){return []}');
    await expect(manager.install({id: 'fixture', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_CONTENT_CONFLICT'});
    await expect(manager.install({id: 'fixture', version: '0.2.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_VERSION_CONFLICT'});
    const other = await fixture({id: 'escaping'}); await symlink(f.module, path.join(other.packageRoot, 'node/link.mjs'));
    const unsafe = other.manager(); await unsafe.initialize(); await unsafe.bind(await runtime());
    await expect(unsafe.install({id: 'escaping', version: '0.1.0'})).rejects.toMatchObject({code: 'TOOL_PACKAGE_PATH_INVALID'});
    expect(() => toolPackageDirectories({NESTOS_TOOL_PACKAGE_DIRS: '["relative"]'})).toThrow('absolute');
});

it('does not drop sibling registry entries when separate host managers install packages concurrently', async () => {
    const first = await fixture(), second = await fixture({id: 'second', root: first.root});
    const a = first.manager(), b = second.manager(); await Promise.all([a.initialize(), b.initialize()]);
    await a.bind(await runtime()); await b.bind(await runtime());
    await Promise.all([a.install({id: 'fixture', version: '0.1.0'}), b.install({id: 'second', version: '0.1.0'})]);
    const saved = JSON.parse(await readFile(path.join(first.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8'));
    expect(saved.packages.map((item: {id: string}) => item.id).sort()).toEqual(['fixture', 'second']);
    const restored = first.manager(); await restored.initialize();
    const driver = new ToolDeviceDriver(restored.initialTools()); await driver.init();
    expect(driver.getToolMeta('fixture.convert')).toBeDefined(); expect(driver.getToolMeta('second.convert')).toBeDefined(); await driver.dispose();
});

it('includes copied executable contents in immutable package fingerprints and startup verification', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); await manager.bind(await runtime());
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
    await manager.initialize(); await manager.bind(kernel);
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
    const manager = first.manager(); await manager.initialize(); await manager.bind(await runtime());
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

const guideYaml = (title = 'Setup') => `version: 1
connectionTypes: [fixture-account]
title: ${title}
steps:
  - title: Register
    description: Register even when setup needs review.
    command: example --value '<input>'
    links:
      - label: Documentation
        url: https://docs.example.com/setup
`;

it('keeps guides available after registration and updates documentation without changing executable identity', async () => {
    const f = await fixture(), manager = f.manager(), kernel = await runtime();
    const guideFile = path.join(f.packageRoot, 'guide.yaml'); await writeFile(guideFile, guideYaml());
    await manager.initialize(); await manager.bind(kernel);
    expect(await manager.list()).toMatchObject([{status: 'available', guide: {title: 'Setup', connectionTypes: ['fixture-account'], steps: [{title: 'Register'}]}}]);
    await manager.install({id: 'fixture', version: '0.1.0'});
    const registry = path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), before = await readFile(registry, 'utf8');
    await writeFile(guideFile, guideYaml('Updated setup'));
    expect(await manager.list()).toMatchObject([{status: 'registered', guide: {title: 'Updated setup'}}]);
    await manager.install({id: 'fixture', version: '0.1.0'});
    expect(await readFile(registry, 'utf8')).toBe(before);
    expect(await (await kernel.sessions.get('guide-run')).toolService.invoke({toolId: f.toolId, args: {value: 'still works'}, resultMode: 'structured'})).toMatchObject({success: true, data: 'still works'});
    const restored = new NodeToolPackages({env: f.env, directories: []}); cleanups.push(() => restored.close());
    await restored.initialize(); await restored.bind(await runtime(restored.initialTools()));
    expect(await restored.list()).toMatchObject([{status: 'registered', guide: {title: 'Setup'}}]);
});

it('adds a guide to packages registered before guides existed without reinstalling executable code', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); await manager.bind(await runtime());
    await manager.install({id: 'fixture', version: '0.1.0'});
    expect((await manager.list())[0].guide).toBeUndefined();
    await writeFile(path.join(f.packageRoot, 'guide.yaml'), guideYaml());
    expect(await manager.list()).toMatchObject([{status: 'registered', guide: {title: 'Setup'}}]);
});

it.each([
    ['version: [private-guide-marker', 'TOOL_PACKAGE_GUIDE_YAML_INVALID'],
    [guideYaml().replace('https://docs.example.com/setup', 'javascript:alert(1)'), 'TOOL_PACKAGE_GUIDE_INVALID'],
    [guideYaml().replace('https://docs.example.com/setup', 'https://user:password@example.com'), 'TOOL_PACKAGE_GUIDE_INVALID'],
    [guideYaml().replace('[fixture-account]', '[invalid type]'), 'TOOL_PACKAGE_GUIDE_INVALID'],
    [guideYaml().replace('[fixture-account]', 'fixture-account'), 'TOOL_PACKAGE_GUIDE_INVALID'],
    [guideYaml().replace('steps:', 'unusedSteps:'), 'TOOL_PACKAGE_GUIDE_INVALID'],
    ['x'.repeat(65537), 'TOOL_PACKAGE_GUIDE_TOO_LARGE'],
])('isolates invalid package documentation from executable registration (%#)', async (yaml, code) => {
    const f = await fixture(), manager = f.manager();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(path.join(f.packageRoot, 'guide.yaml'), yaml); await manager.initialize(); await manager.bind(await runtime());
    expect(await manager.list()).toMatchObject([{status: 'available', guideError: code}]);
    await expect(manager.install({id: 'fixture', version: '0.1.0'})).resolves.toBeUndefined();
    expect(await manager.list()).toMatchObject([{status: 'registered', guideError: code}]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-guide-marker');
});

it('rejects symbolic links for package documentation and validates all bundled package guides', async () => {
    const f = await fixture(); await writeFile(path.join(f.root, 'external.yaml'), guideYaml());
    await symlink(path.join(f.root, 'external.yaml'), path.join(f.packageRoot, 'guide.yaml'));
    await expect(readPackageGuide(f.packageRoot)).rejects.toMatchObject({code: 'TOOL_PACKAGE_GUIDE_PATH_INVALID'});
    const catalog = fileURLToPath(new URL('../../../tools/', import.meta.url));
    for (const name of ['googlecli', 'anki-cli']) {
        const guide = await readPackageGuide(path.join(catalog, name)); expect(guide?.steps.length).toBeGreaterThan(0);
    }
});

it('removes a registered package from existing and future tool scopes while keeping user connections separate', async () => {
    const f = await fixture(), manager = f.manager(), kernel = await runtime();
    await manager.initialize(); await manager.bind(kernel); await manager.install({id: 'fixture', version: '0.1.0'});
    expect(await manager.list()).toMatchObject([{status: 'registered', canUninstall: true}]);
    await manager.uninstall('fixture', '0.1.0');
    expect(kernel.toolCatalog.getToolMeta(f.toolId)).toBeUndefined();
    expect(await manager.list()).toMatchObject([{status: 'available', canUninstall: false}]);
    expect(JSON.parse(await readFile(path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8')).packages).toEqual([]);
});

it('activates a new package version immediately in all loaded runtimes and migrates user settings', async () => {
    const f = await fixture(), connections = new NodeToolConnections(path.join(f.root, 'private-connections'));
    cleanups.push(() => connections.close());
    f.manifest.executables = [];
    await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), JSON.stringify(f.manifest));
    const module = (await readFile(f.module, 'utf8')).replace('createTools({buildTool,z}) {', `createTools({buildTool,z,connections}) {connections?.register({id:'fixture-account',name:'Account',description:'',fields:[{name:'token',label:'Token',secret:true,required:true}]});`);
    await writeFile(f.module, module);
    await writeFile(path.join(f.packageRoot, 'toolbox.yaml'), 'version: 2\nconnections:\n  fixture-account: [browser, import]\ntools:\n  fixture.convert:\n    parameters:\n      - name: value\n');
    const create = async () => {
        const manager = new NodeToolPackages({env: f.env, connections}); cleanups.push(() => manager.close());
        await manager.initialize(); const host = await runtime(manager.initialTools()); await manager.bind(host); return {manager, host};
    };
    const initial = await create(); await initial.manager.install({id: 'fixture', version: '0.1.0'});
    await initial.manager.configure('fixture', '0.1.0', {enabled: true, defaults: {'fixture.convert': {value: 'saved-default'}}});
    await connections.save({id: 'account', type: 'fixture-account', name: 'Private', values: {token: 'PRIVATE_TOKEN'}});
    expect((await initial.manager.list())[0].connectionTypes).toContain('fixture-account');
    await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), JSON.stringify({...f.manifest, version: '0.2.0'}));
    await writeFile(f.module, module.replace("name:'Account'", "name:'Next account'").replace('data:args.value', "data:'next:'+args.value"));
    const active = await create(), scope = await active.host.sessions.get('active-before-switch');
    expect(await active.manager.list()).toMatchObject([{version: '0.1.0', status: 'registered', connectionTypes: ['fixture-account']}, {version: '0.2.0', status: 'available', canSwitch: true}]);
    const activeExecutable = process.env.NESTOS_FIXTURE_TOOL_BIN;
    expect(packageSourceEnvironment(process.env).NESTOS_FIXTURE_TOOL_BIN).toBe(priorExecutable);
    await active.manager.switchVersion('fixture', '0.2.0', '0.1.0');
    expect(process.env.NESTOS_FIXTURE_TOOL_BIN).toBe(activeExecutable);
    expect(await scope.toolService.invoke({toolId: f.toolId, args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: 'next:saved-default'});
    expect(await active.manager.list()).toMatchObject([{version: '0.2.0', status: 'registered'}]);
    expect((await active.manager.list())[0].pendingVersion).toBeUndefined();
    expect((await initial.manager.list())[0].version).toBe('0.2.0');
    expect((await connections.snapshot()).types[0].name).toBe('Next account');
    expect(await connections.resolve('account', 'fixture-account')).toEqual({token: 'PRIVATE_TOKEN'});
    await initial.host.dispose(); await active.host.dispose();
    await initial.manager.close(); await active.manager.close();
    const restarted = await create();
    expect((await restarted.manager.list()).find(item => item.version === '0.2.0')).toMatchObject({status: 'registered', configuration: {enabled: true, defaults: {'fixture.convert': {value: 'saved-default'}}}});
    expect(await (await restarted.host.sessions.get('after-restart')).toolService.invoke({toolId: f.toolId, args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: 'next:saved-default'});
    expect((await connections.snapshot()).types[0].name).toBe('Next account');
    expect(await connections.resolve('account', 'fixture-account')).toEqual({token: 'PRIVATE_TOKEN'});
});

it('rejects incompatible or unauthorized version switches and retains the registered package', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); await manager.bind(await runtime());
    await manager.install({id: 'fixture', version: '0.1.0'});
    await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), JSON.stringify({...f.manifest, version: '0.2.0', tools: [{id: f.toolId, version: '2'}]}));
    await writeFile(f.module, (await readFile(f.module, 'utf8')).replace("version:'1'", "version:'2'"));
    const candidate = f.manager(); await candidate.initialize(); await candidate.bind(await runtime(candidate.initialTools()));
    await expect(candidate.switchVersion('fixture', '0.2.0', '0.1.0')).rejects.toMatchObject({code: 'TOOL_PACKAGE_SWITCH_INCOMPATIBLE'});
    const registry = JSON.parse(await readFile(path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8'));
    expect(registry.packages[0].version).toBe('0.1.0');
    const readonly = new NodeToolPackages({env: f.env, canManage: false}); cleanups.push(() => readonly.close());
    await readonly.initialize(); await readonly.bind(await runtime(readonly.initialTools()));
    expect((await readonly.list()).find(item => item.version === '0.2.0')?.canSwitch).toBe(false);
    await expect(readonly.switchVersion('fixture', '0.2.0', '0.1.0')).rejects.toMatchObject({code: 'TOOL_PACKAGE_SWITCH_DENIED'});
});

it('validates inactive connection declarations without changing the running registration', async () => {
    const f = await fixture(), manager = f.manager(); await manager.initialize(); const host = await runtime(); await manager.bind(host);
    await manager.install({id: 'fixture', version: '0.1.0'});
    await writeFile(path.join(f.packageRoot, 'nestos-tool.json'), JSON.stringify({...f.manifest, version: '0.2.0'}));
    await writeFile(f.module, (await readFile(f.module, 'utf8')).replace('createTools({buildTool,z}) {', `createTools({buildTool,z,connections}) {connections?.register({id:'invalid type',name:'Invalid',description:'',fields:[{name:'key',label:'Key'}]});`));
    const candidate = f.manager(); await candidate.initialize(); const running = await runtime(candidate.initialTools()); await candidate.bind(running);
    await expect(candidate.switchVersion('fixture', '0.2.0', '0.1.0')).rejects.toMatchObject({code: 'TOOL_PACKAGE_CONNECTION_INVALID'});
    expect(await (await running.sessions.get('unchanged')).toolService.invoke({toolId: f.toolId, args: {value: 'original'}, resultMode: 'structured'})).toMatchObject({success: true, data: 'original'});
    const registry = JSON.parse(await readFile(path.join(f.env.XDG_CONFIG_HOME, 'nestos/tool-packages.json'), 'utf8'));
    expect(registry.packages[0].version).toBe('0.1.0');
});

import {afterEach, expect, it, vi} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MemoryBackend, type IDeviceDriver} from '@itookit/vfs-core';
import {createKernelAdaptersRuntime} from '@itookit/kernel-adapters';
import {createApplicationRuntime} from '@itookit/app-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {NodeToolPackages} from '../src/runtime/tool-packages';
import {ToolPreferences} from '../src/runtime/tool-packages/preferences';
import {readToolbox} from '../src/runtime/tool-packages/toolbox';
import {readToolPackage} from '../src/runtime/tool-packages/manifest';
import {fileURLToPath} from 'node:url';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-preferences-')); cleanup.push(() => rm(root, {recursive: true, force: true}));
    const catalog = path.join(root, 'catalog'), source = path.join(catalog, 'fixture'); await mkdir(source, {recursive: true});
    await writeFile(path.join(source, 'nestos-tool.json'), JSON.stringify({format: 1, id: 'fixture', version: '1', module: 'extension.mjs', tools: [{id: 'fixture.convert', version: '1'}]}));
    await writeFile(path.join(source, 'extension.mjs'), `export function createTools({buildTool,z}) {return [buildTool({name:'fixture.convert',version:'1',maxResultSizeChars:1000,mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),isReadOnly:()=>true,
        inputSchema:z.strictObject({value:z.string().min(1),count:z.number().int().min(1).max(5).optional()}),description:async()=>'Converter',
        call:async args=>({data:args}),reconcile:async args=>({status:'completed',data:args})})]}`);
    await writeFile(path.join(source, 'toolbox.yaml'), 'version: 1\npreinstall: true\ntools:\n  fixture.convert:\n    parameters:\n      - name: value\n        label: Default value\n      - name: count\n');
    const options = {env: {PATH: '', XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data')}, directories: [catalog]};
    const manager = async (user: string, directories = options.directories) => {
        const instance = new NodeToolPackages({...options, directories, preferencesFile: path.join(root, user, 'private/preferences.json')});
        cleanup.push(() => instance.close()); await instance.initialize(); return instance;
    };
    return {root, source, manager};
}
async function kernel(manager: NodeToolPackages) {
    const runtime = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver, additionalTools: manager.initialTools()});
    cleanup.push(() => runtime.dispose()); await manager.bind(runtime); return runtime;
}
const configured = {enabled: true, defaults: {'fixture.convert': {value: 'user-a', count: 2}}};

it('preinstalls shared code once, defaults each user to disabled, and updates active and future scopes independently', async () => {
    const f = await fixture(), a = await f.manager('a'), b = await f.manager('b', []), ka = await kernel(a), kb = await kernel(b);
    const before = await ka.sessions.get('before'), other = await kb.sessions.get('other');
    expect(await a.list()).toMatchObject([{status: 'registered', configuration: {enabled: false, defaults: {}}}]);
    expect(ka.toolCatalog.getToolMeta('fixture.convert')?.enabled).toBe(false);
    expect((await a.ensure([{id: 'fixture.convert', version: '1'}])).tools[0]).toMatchObject({code: 'TOOL_PACKAGE_TOOL_DISABLED'});
    await a.configure('fixture', '1', configured);
    expect(before.toolService.getToolDefinitions().some(item => item.function?.name === 'fixture.convert')).toBe(true);
    expect(await before.toolService.invoke({toolId: 'fixture.convert', args: {}})).toMatchObject({success: true, data: {value: 'user-a', count: 2}});
    expect(await before.toolService.invoke({toolId: 'fixture.convert', args: {value: 'explicit', count: 4}})).toMatchObject({success: true, data: {value: 'explicit', count: 4}});
    expect((await ka.sessions.get('future')).toolService.getToolMeta('fixture.convert')?.enabled).toBe(true);
    expect(await other.toolService.invoke({toolId: 'fixture.convert', args: {value: 'b'}})).toMatchObject({errorCode: 'TOOL_DISABLED'});
    await b.configure('fixture', '1', {enabled: true, defaults: {'fixture.convert': {value: 'user-b'}}});
    expect(await other.toolService.invoke({toolId: 'fixture.convert', args: {}})).toMatchObject({data: {value: 'user-b'}});
    await a.configure('fixture', '1', {...configured, enabled: false});
    expect(before.toolService.getToolDefinitions().some(item => item.function?.name === 'fixture.convert')).toBe(false);
    expect(await before.toolService.invoke({toolId: 'fixture.convert', args: {}})).toMatchObject({errorCode: 'TOOL_DISABLED'});
    expect((await a.list())[0].status).toBe('registered');
    const reopened = await f.manager('a', []); expect(await reopened.list()).toMatchObject([{configuration: {...configured, enabled: false}}]);
    expect((await stat(path.join(f.root, 'a/private/preferences.json'))).mode & 0o077).toBe(0);
    expect((await stat(path.join(f.root, 'a/private'))).mode & 0o077).toBe(0);
});

it('does not let Flow dependency preparation activate a disabled tool and exposes inherited scanner defaults without changing target identity', async () => {
    const f = await fixture(), manager = await f.manager('a');
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false, toolDependencies: manager,
        kernelPlatform: {additionalTools: manager.initialTools(), configure: async kernel => {await manager.bind(kernel);}}}); cleanup.push(() => runtime.dispose());
    const flow = {id: 'uses-defaults', name: 'Uses defaults', draftVersion: 1, updatedAt: 0, layout: {}, edges: [], toolDependencies: [{id: 'fixture.convert', version: '1'}],
        nodes: [{id: 'value', name: 'Value', plugin: 'builtin.tool', pluginVersion: '1.0.0', config: {toolId: 'fixture.convert', toolVersion: '1', args: {}}, inputs: {}}]};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    expect(await runtime.flowInstallations.ensure(flow.id)).toMatchObject({status: 'needsConfiguration', tools: [{code: 'TOOL_PACKAGE_TOOL_DISABLED'}]});
    expect((await runtime.digitalTwin.collectionTools()).some(item => item.target.id === 'fixture.convert')).toBe(false);
    await runtime.toolPackages.configure!('fixture', '1', configured);
    expect((await runtime.flowInstallations.check(flow.id)).status).toBe('ready');
    const first = (await runtime.digitalTwin.collectionTools()).find(item => item.target.id === 'fixture.convert')!; expect(first.defaults).toEqual(configured.defaults['fixture.convert']);
    await runtime.toolPackages.configure!('fixture', '1', {enabled: true, defaults: {'fixture.convert': {value: 'changed'}}});
    const second = (await runtime.digitalTwin.collectionTools()).find(item => item.target.id === 'fixture.convert')!; expect(second.target).toEqual(first.target); expect(second.defaults).toEqual({value: 'changed'});
    await runtime.projects.personal();
    const plan = await runtime.digitalTwin.saveScanRule(null, null, {name: 'Default collector', collection: {target: second.target, values: {}}, mode: 'collect', include: [], exclude: [], trigger: 'manual', intervalMinutes: 30, enabled: true});
    const run = await runtime.digitalTwin.runScanPlan(plan); await runtime.digitalTwin.waitScanRun(run);
    expect((await runtime.digitalTwin.snapshot()).scans.runs.find(item => item.id === run)!.data.state).toBe('succeeded');

});

it('rejects undeclared, invalid and secret parameters atomically without logging their values', async () => {
    const f = await fixture(), manager = await f.manager('a'); await kernel(manager);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const defaults of [{'fixture.convert': {count: 99}}, {'fixture.convert': {token: 'PRIVATE_TOKEN'}}, {'unknown.tool': {value: 'PRIVATE_TOKEN'}}]) {
        await expect(manager.configure('fixture', '1', {enabled: true, defaults} as never)).rejects.toMatchObject({code: 'TOOL_PACKAGE_DEFAULT_INVALID'});
    }
    expect((await manager.list())[0].configuration?.enabled).toBe(false);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_TOKEN');
    await expect(manager.configure('fixture', 'other', configured)).rejects.toMatchObject({code: 'TOOL_PACKAGE_CONFIGURATION_UNAVAILABLE'});
});

it('rejects corrupt or non-private preference storage without leaking its contents', async () => {
    const f = await fixture(), directory = path.join(f.root, 'private'); await mkdir(directory, {mode: 0o700});
    const file = path.join(directory, 'preferences.json'); await writeFile(file, '{"secret":"PRIVATE_TOKEN", broken]', {mode: 0o600});
    await expect(new ToolPreferences(file).initialize()).rejects.toMatchObject({code: 'TOOL_PACKAGE_PREFERENCES_INVALID'});
    await rm(file); await symlink(path.join(f.source, 'nestos-tool.json'), file);
    await expect(new ToolPreferences(file).initialize()).rejects.toMatchObject({code: 'TOOL_PACKAGE_PREFERENCES_NOT_PRIVATE'});
});

it('validates bundled YAML declarations without requiring business code or special tool names in the host', async () => {
    const catalog = fileURLToPath(new URL('../../../tools/', import.meta.url));
    for (const name of ['googlecli', 'anki-cli']) expect((await readToolbox(await readToolPackage(path.join(catalog, name))))?.preinstall).toBe(true);
});

it('distributes new YAML to an existing shared installation so non-admin users cannot bypass the default-disabled gate', async () => {
    const f = await fixture(), yaml = await readFile(path.join(f.source, 'toolbox.yaml'), 'utf8'); await rm(path.join(f.source, 'toolbox.yaml'));
    const legacy = await f.manager('legacy'); await kernel(legacy); await legacy.install({id: 'fixture', version: '1'});
    const file = path.join(f.root, 'config/nestos/tool-packages.json'), before = await readFile(file, 'utf8');
    await writeFile(path.join(f.source, 'toolbox.yaml'), yaml);
    await writeFile(path.join(f.source, 'guide.yaml'), 'version: 1\ntitle: Updated guide\nsteps: [{title: Enable, description: Enable for yourself}]');
    const admin = await f.manager('admin'), user = await f.manager('new-user', []);
    expect((await admin.list())[0].configuration?.enabled).toBe(false);
    expect((await user.list())[0].configuration?.enabled).toBe(false);
    expect((await user.list())[0].guide?.title).toBe('Updated guide');
    expect((await kernel(user)).toolCatalog.getToolMeta('fixture.convert')?.enabled).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(before);
});
it('enforces individual tool disablement and records successful invocations privately', async () => {
    const f = await fixture(), manager = await f.manager('a'), runtime = await kernel(manager), session = await runtime.sessions.get('tools');
    await manager.configure('fixture', '1', configured);
    await session.toolService.invoke({toolId: 'fixture.convert', args: {value: 'private-argument'}});
    expect(await manager.history('fixture', '1')).toMatchObject([{status: 'succeeded', toolId: 'fixture.convert'}]);
    expect(JSON.stringify(await manager.history('fixture', '1'))).not.toContain('private-argument');
    await manager.configure('fixture', '1', {...configured, disabledTools: ['fixture.convert']});
    expect(await session.toolService.invoke({toolId: 'fixture.convert', args: {value: 'test'}})).toMatchObject({success: false, errorCode: 'TOOL_DISABLED'});
    await expect(manager.uninstall('fixture', '1')).rejects.toMatchObject({code: 'TOOL_PACKAGE_REMOVE_DENIED'});
});

it('keeps incompatible settings private and rejects activation without changing the running version', async () => {
    const f = await fixture(), first = await f.manager('a'); await kernel(first);
    await first.configure('fixture', '1', configured);
    const manifestFile = path.join(f.source, 'nestos-tool.json'), moduleFile = path.join(f.source, 'extension.mjs');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(manifestFile, JSON.stringify({...manifest, version: '2'}));
    await writeFile(moduleFile, (await readFile(moduleFile, 'utf8')).replace('value:z.string().min(1)', 'value:z.number()'));
    const pending = await f.manager('a'); await kernel(pending); await expect(pending.switchVersion('fixture', '2', '1')).rejects.toMatchObject({code: 'TOOL_PACKAGE_DEFAULT_INVALID'});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restarted = await f.manager('a');
    expect((await restarted.list()).find(item => item.version === '1')).toMatchObject({status: 'registered', configuration: configured});
    expect((await restarted.list()).find(item => item.version === '2')?.status).toBe('available');
    const saved = JSON.parse(await readFile(path.join(f.root, 'a/private/preferences.json'), 'utf8'));
    expect(saved.packages['fixture@1']).toEqual(configured);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('user-a');
});

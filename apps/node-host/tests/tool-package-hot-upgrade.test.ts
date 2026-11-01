import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createKernelAdaptersRuntime} from '@itookit/kernel-adapters';
import {createVFS, MemoryBackend, type IDeviceDriver} from '@itookit/vfs-core';
import {Kernel} from '../../../libraries/durable-kernel/src/index';
import {createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms} from '../../../backend/llm-flow/src/index';
import {createTaskAssetStore} from '../../../backend/app-core/src/runtime/task-asset-store';
import type {TaskAssetStore, ToolExecutionIdentity} from '@itookit/tools/contracts';
import {NodeToolPackages} from '../src/runtime/tool-packages';
import * as registry from '../src/runtime/tool-packages/store';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); delete (globalThis as any).__hotUpgradeTest;});
const identity = (id: string): ToolExecutionIdentity => ({sessionId: 'fixture', taskId: id, effectId: 'tool', operationId: id});
async function fixture({native = false, isolated = true, taskAssetStore}: {native?: boolean; isolated?: boolean; taskAssetStore?: TaskAssetStore} = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-hot-upgrade-')); cleanups.push(() => rm(root, {recursive: true, force: true}));
    const source = path.join(root, 'catalog/fixture'); await mkdir(path.join(source, 'node'), {recursive: true});
    const records = new Map<string, unknown>();
    const assets: TaskAssetStore = {write: async () => {throw new Error('unused');},
        getRecord: async (key, owner) => structuredClone(records.get(owner.taskId + '/' + key)),
        putRecord: async (key, value, owner) => {const id = owner.taskId + '/' + key, prior = records.get(id);
            if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('identity conflict'); records.set(id, structuredClone(value));}};
    const controls = {calls: [] as string[], wait: Promise.resolve(), release: () => {}};
    (globalThis as any).__hotUpgradeTest = controls;
    const version = async (value: string, body = '') => {
        if (native) {await mkdir(path.join(source, 'bin'), {recursive: true}); await writeFile(path.join(source, 'bin/fixture-cli'), `#!/bin/sh\nprintf '%s' '${value}'\n`); await chmod(path.join(source, 'bin/fixture-cli'), 0o755);}
        await writeFile(path.join(source, 'nestos-tool.json'), JSON.stringify({format: 1, id: 'fixture', version: value, module: 'node/extension.mjs', files: ['node'], tools: [{id: 'fixture.collect', version: '1'}],
            ...(native ? {executionEnvironment: isolated ? 'instance' : undefined, executables: [{env: 'NESTOS_HOT_FIXTURE_BIN', command: 'fixture-cli', default: 'bin/fixture-cli'}]} : {})}));
        await writeFile(path.join(source, 'toolbox.yaml'), 'version: 2\ntools:\n  fixture.collect:\n    parameters:\n      - name: value\n');
        await writeFile(path.join(source, 'node/extension.mjs'), `import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
            export function createTools({buildTool,z,executables}) {${body} return [buildTool({name:'fixture.collect',version:'1',
            mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),inputSchema:z.object({value:z.string()}),description:async()=>${JSON.stringify('Version ' + value)},
            call:async(args,context)=>{const test=globalThis.__hotUpgradeTest; test?.calls.push(${JSON.stringify(value)});
                if(${JSON.stringify(value)}==='1.0.0' && context.operationId==='old') await test?.wait;
                return {data:{version:${JSON.stringify(value)},value:args.value${native ? ",executable:(await promisify(execFile)(executables.NESTOS_HOT_FIXTURE_BIN,[])).stdout.trim()" : ''}}};},
            reconcile:async(args)=>({status:'completed',data:{version:${JSON.stringify(value)},value:args.value}})})]}`);
    };
    const create = async (user = 'first', overrides: Record<string, unknown> = {}) => {
        const manager = new NodeToolPackages({env: {PATH: ''}, directories: [path.dirname(source)], dataDirectory: path.join(root, 'tools'),
            registryFile: path.join(root, 'registry.json'), preferencesFile: path.join(root, user, 'preferences.json'), ...overrides});
        cleanups.push(() => manager.close()); await manager.initialize();
        const host = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver, additionalTools: manager.initialTools(), taskAssetStore: taskAssetStore ?? assets});
        cleanups.push(() => host.dispose()); await manager.bind(host);
        return {manager, host, scope: await host.sessions.get(user)};
    };
    await version('1.0.0'); const initial = await create(); await initial.manager.install({id: 'fixture', version: '1.0.0'});
    await initial.manager.configure('fixture', '1.0.0', {enabled: true, defaults: {'fixture.collect': {value: 'first-user'}}});
    return {root, source, records, assets, controls, version, create, ...initial};
}

it('switches new calls immediately while an old call remains in flight, with exact restoration and reconciliation', async () => {
    const f = await fixture();
    f.controls.wait = new Promise(resolve => {f.controls.release = resolve;});
    const old = f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('old'), resultMode: 'structured'});
    await vi.waitFor(() => expect(f.controls.calls).toEqual(['1.0.0']));
    await f.version('1.1.0');
    await f.manager.switchVersion('fixture', '1.1.0', '1.0.0', 'upgrade-one');
    const active = (await f.manager.list()).find(item => item.status === 'registered')!;
    expect(active.version).toBe('1.1.0'); expect(active.pendingVersion).toBeUndefined();
    expect(active.runningVersions).toEqual([{version: '1.0.0', count: 1}]);
    expect(f.host.toolCatalog.getToolMeta('fixture.collect')?.description).toBe('Version 1.1.0');
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('new'), resultMode: 'structured'}))
        .toMatchObject({success: true, data: {version: '1.1.0', value: 'first-user'}});
    f.controls.release(); expect(await old).toMatchObject({success: true, data: {version: '1.0.0'}});
    expect((await f.manager.list()).find(item => item.status === 'registered')?.runningVersions).toEqual([]);
    await f.host.dispose(); await f.manager.close();
    const restored = await f.create();
    expect(await restored.scope.toolService.reconcile!({toolId: 'fixture.collect', args: {}, ...identity('old'), resultMode: 'structured'}))
        .toMatchObject({status: 'completed', result: {data: {version: '1.0.0', value: 'first-user'}}});
    expect(await restored.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('old'), resultMode: 'structured'}))
        .toMatchObject({success: true, data: {version: '1.0.0'}});
    expect(await restored.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('after-restart'), resultMode: 'structured'}))
        .toMatchObject({success: true, data: {version: '1.1.0'}});
});

it('publishes to all loaded users and late joiners while preserving each user settings', async () => {
    const f = await fixture(), second = await f.create('second');
    await second.manager.configure('fixture', '1.0.0', {enabled: true, defaults: {'fixture.collect': {value: 'second-user'}}});
    await f.version('1.1.0'); await f.manager.switchVersion('fixture', '1.1.0', '1.0.0', 'shared-upgrade');
    for (const [runtime, value] of [[f, 'first-user'], [second, 'second-user']] as const) {
        expect(await runtime.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: {version: '1.1.0', value}});
        expect((await runtime.manager.list()).find(item => item.status === 'registered')?.version).toBe('1.1.0');
    }
    const late = await f.create('second');
    expect(await late.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: {version: '1.1.0', value: 'second-user'}});
});

it('keeps all users and the durable pointer unchanged when any participant preparation fails', async () => {
    const f = await fixture(), second = await f.create('second');
    vi.spyOn(second.host, 'prepareToolUpdate').mockRejectedValueOnce(new Error('PRIVATE_PREPARE_FAILURE'));
    await f.version('1.1.0'); await expect(f.manager.switchVersion('fixture', '1.1.0', '1.0.0')).rejects.toThrow();
    expect((await registry.readToolPackageRegistry(path.join(f.root, 'registry.json')))[0].version).toBe('1.0.0');
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: {version: '1.0.0'}});
});

it('resolves a lost registry-write acknowledgement without replaying the switch operation', async () => {
    const f = await fixture(); await f.version('1.1.0');
    const original = registry.writeToolPackageRegistry;
    vi.spyOn(registry, 'writeToolPackageRegistry').mockImplementationOnce(async (...args) => {await original(...args); throw new Error('lost acknowledgement');});
    await f.manager.switchVersion('fixture', '1.1.0', '1.0.0', 'stable-operation');
    const prepare = vi.spyOn(f.host, 'prepareToolUpdate');
    await f.manager.switchVersion('fixture', '1.1.0', '1.0.0', 'stable-operation');
    expect(prepare).not.toHaveBeenCalled();
    expect((await f.manager.list()).find(item => item.status === 'registered')?.activationId).toBe('stable-operation');
});

it('never guesses the latest implementation for an unbound legacy reconciliation', async () => {
    const f = await fixture(); await f.version('1.1.0'); await f.manager.switchVersion('fixture', '1.1.0', '1.0.0');
    await expect(f.scope.toolService.reconcile!({toolId: 'fixture.collect', args: {}, ...identity('legacy')})).rejects.toMatchObject({code: 'TOOL_PACKAGE_LEGACY_EXECUTION_UNBOUND'});
    expect(f.controls.calls).toEqual([]);
});

it('refuses unavailable or tampered historical implementations instead of falling through to the active version', async () => {
    const f = await fixture();
    await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('bound'), resultMode: 'structured'});
    await f.version('1.1.0'); await f.manager.switchVersion('fixture', '1.1.0', '1.0.0');
    await f.host.dispose(); await f.manager.close();
    await writeFile(path.join(f.root, 'tools/fixture/1.0.0/node/extension.mjs'), 'export const tampered=true');
    const restored = await f.create();
    await expect(restored.scope.toolService.reconcile!({toolId: 'fixture.collect', args: {}, ...identity('bound')})).rejects.toMatchObject({code: 'TOOL_PACKAGE_CONTENT_CONFLICT'});
    expect(f.controls.calls).toEqual(['1.0.0']);
});

it('isolates new and draining executable paths without mutating the shared process environment', async () => {
    const previous = process.env.NESTOS_HOT_FIXTURE_BIN, f = await fixture({native: true});
    f.controls.wait = new Promise(resolve => {f.controls.release = resolve;});
    const old = f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('old'), resultMode: 'structured'});
    await vi.waitFor(() => expect(f.controls.calls).toEqual(['1.0.0']));
    await f.version('1.1.0'); await f.manager.switchVersion('fixture', '1.1.0', '1.0.0');
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: {executable: '1.1.0'}});
    f.controls.release(); expect(await old).toMatchObject({success: true, data: {executable: '1.0.0'}});
    expect(process.env.NESTOS_HOT_FIXTURE_BIN).toBe(previous);
});

it('rejects changed executable bindings when the package still relies on a process-global environment', async () => {
    const f = await fixture({native: true, isolated: false}); await f.version('1.1.0');
    await expect(f.manager.switchVersion('fixture', '1.1.0', '1.0.0')).rejects.toMatchObject({code: 'TOOL_PACKAGE_EXECUTABLE_ISOLATION_REQUIRED'});
    expect((await registry.readToolPackageRegistry(path.join(f.root, 'registry.json')))[0].version).toBe('1.0.0');
});

it('rolls back already-published participants and migrates fresh user settings on the next attempt', async () => {
    const f = await fixture(), second = await f.create('second');
    const original = second.host.prepareToolUpdate.bind(second.host);
    vi.spyOn(second.host, 'prepareToolUpdate').mockImplementationOnce(async (...args) => {
        const plan = await original(...args); return {...plan, commit: () => {throw new Error('commit failed');}};
    });
    await f.version('1.1.0'); await expect(f.manager.switchVersion('fixture', '1.1.0', '1.0.0')).rejects.toThrow();
    expect((await registry.readToolPackageRegistry(path.join(f.root, 'registry.json')))[0].version).toBe('1.0.0');
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: {version: '1.0.0'}});
    await f.manager.configure('fixture', '1.0.0', {enabled: true, defaults: {'fixture.collect': {value: 'changed-after-failure'}}});
    await f.manager.switchVersion('fixture', '1.1.0', '1.0.0');
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'})).toMatchObject({success: true, data: {value: 'changed-after-failure', version: '1.1.0'}});
});

it('does not execute business code when the Task implementation record cannot be persisted', async () => {
    const f = await fixture(); vi.spyOn(f.assets, 'putRecord').mockRejectedValueOnce(new Error('PRIVATE_STORAGE_ERROR'));
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: identity('no-write'), resultMode: 'structured'}))
        .toMatchObject({success: false, errorCode: 'TOOL_PACKAGE_BINDING_WRITE_FAILED'});
    expect(f.controls.calls).toEqual([]);
});


it('restores the original implementation from real Task storage after runtime recreation and Task retry', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    cleanups.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/durable'})});
    registerDurablePrograms(kernel); await kernel.initialize();
    const executor = new DurableFlowExecutor({kernel, plugins: createBuiltinDagPluginRegistry()});
    cleanups.push(async () => {kernel.dispose(); await executor.waitIdle();});
    await kernel.createSession({id: 'durable', storage: {kind: 'test', locator: null}});
    const run = await executor.submit('durable', {nodes: [{id: 'owner', name: 'Owner', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 1}}], edges: []});
    await run.root.wait({timeoutMs: 4000});
    const owner = {...identity('owner'), sessionId: 'durable', taskId: run.nodes.get('owner')!.id};
    const f = await fixture({taskAssetStore: createTaskAssetStore(() => kernel)});
    expect(await f.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, executionIdentity: owner, resultMode: 'structured'}))
        .toMatchObject({success: true, data: {version: '1.0.0'}});
    await f.version('1.1.0'); await f.manager.switchVersion('fixture', '1.1.0', '1.0.0');
    await f.host.dispose(); await f.manager.close();
    const retry = await kernel.retryTask('durable', owner.taskId, {requestId: 'implementation-retry'});
    const restored = await f.create();
    expect(await restored.scope.toolService.reconcile!({toolId: 'fixture.collect', args: {}, ...owner, taskId: retry.id, resultMode: 'structured'}))
        .toMatchObject({status: 'completed', result: {data: {version: '1.0.0', value: 'first-user'}}});
    expect(await restored.scope.toolService.invoke({toolId: 'fixture.collect', args: {}, resultMode: 'structured'}))
        .toMatchObject({success: true, data: {version: '1.1.0'}});
});


it('includes a user opening during the publication barrier without leaving its catalog on the old version', async () => {
    const f = await fixture(); await f.version('1.1.0');
    let prepared!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => {prepared = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
    const original = f.host.prepareToolUpdate.bind(f.host);
    vi.spyOn(f.host, 'prepareToolUpdate').mockImplementationOnce(async (...args) => {
        const plan = await original(...args); prepared(); await gate; return plan;
    });
    const switching = f.manager.switchVersion('fixture', '1.1.0', '1.0.0');
    await reached;
    const joining = f.create('joining'); release();
    await switching; const joined = await joining;
    expect((await joined.manager.list()).find(item => item.status === 'registered')?.version).toBe('1.1.0');
    expect(joined.host.toolCatalog.getToolMeta('fixture.collect')?.description).toBe('Version 1.1.0');
});

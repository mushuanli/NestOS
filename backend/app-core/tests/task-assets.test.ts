import {createTaskAssetStore} from '../src/runtime/task-asset-store';
import {importInputAsset, readInputAsset, stageInputAssets} from '../src/runtime/input-assets';
import { afterEach, expect, it, vi } from 'vitest';
import { Kernel, type EffectExecutionContext } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms } from '@itookit/llm-flow';
import { createMediaResultStore, type LlmMediaEffectRequest } from '@itookit/kernel-adapters';
import { createTaskAssetReader } from '../src/runtime/task-assets';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('classifies an upload persistence failure and retains its safe storage error code', async () => {
    const putAsset = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private storage details'), {code: 'ENOSPC'}));
    const fs = {driver: {exists: async () => true}, meta: {assets: {putAsset}}} as unknown as Parameters<typeof importInputAsset>[0];
    await expect(importInputAsset(fs, 'data:image/png;base64,AQID')).rejects.toMatchObject({code: 'INPUT_ASSET_PERSISTENCE', remoteCode: 'ENOSPC'});
    expect(putAsset).toHaveBeenCalledOnce();
});

it('allows asset transfer within a Flow and rejects cross-run, cross-session and corrupt references', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/'); cleanup.push(() => manager.dispose());
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/s' }) });
    registerDurablePrograms(kernel); await kernel.initialize();
    const executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
    cleanup.push(async () => { kernel.dispose(); await executor.waitIdle(); });
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    const graph = { nodes: ['source', 'consumer'].map(id => ({ id, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'fixture' } })), edges: [] };
    const run = await executor.submit('s', graph); await run.root.wait({ timeoutMs: 4000 });
    const other = await executor.submit('s', graph); await other.root.wait({ timeoutMs: 4000 });
    const source = run.nodes.get('source')!.id, consumer = run.nodes.get('consumer')!.id;
    const store = createMediaResultStore(async () => ({ fs, rootPath: '/s' }));
    const result = await store.put({ request: { model: 'fixture' } } as LlmMediaEffectRequest,
        { model: 'fixture', assets: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }] },
        { sessionId: 's', taskId: source, effectId: 'media', abortSignal: new AbortController().signal } as EffectExecutionContext);
    const read = createTaskAssetReader(() => kernel, fs), identity = { operationId: 'op', sessionId: 's', taskId: consumer, effectId: 'tool' };
    const assets = createTaskAssetStore(() => kernel);
    const written = await assets.write(new Uint8Array([3,2,1]), 'image/png', identity);
    expect(await read(written, identity)).toEqual(new Uint8Array([3,2,1]));
    await assets.putRecord('fixture/v1', {output: written}, identity);
    expect(await assets.getRecord('fixture/v1', identity)).toEqual({output: written});
    await expect(assets.putRecord('fixture/v1', {different:true}, identity)).rejects.toThrow('conflict');
    await expect(assets.getRecord('../invalid key', identity)).rejects.toThrow('record key');
    const writes = await Promise.allSettled([assets.putRecord('concurrent',1,identity),assets.putRecord('concurrent',2,identity)]);
    expect(writes.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    const retried = await kernel.retryTask('s',consumer,{requestId:'asset-retry'});
    const retryIdentity = {...identity,taskId:retried.id};
    expect(await assets.getRecord('fixture/v1',retryIdentity)).toEqual({output:written});
    expect(await read(written,retryIdentity)).toEqual(new Uint8Array([3,2,1]));
    const staged = await stageInputAssets(fs, {images:[{type:'image_url',image_url:{url:'data:image/png;base64,AQID'}}]});
    const input = (staged.images[0] as unknown as {source:{asset:Parameters<typeof readInputAsset>[1]}}).source.asset;
    expect(JSON.stringify(staged)).not.toContain('base64');
    expect(await readInputAsset(fs,input)).toEqual(new Uint8Array([1,2,3]));
    await expect(read(input,identity)).rejects.toThrow('not selected');
    const selected = await executor.submit('s', graph, staged);
    await selected.root.wait({timeoutMs:4000});
    expect(await read(input,{...identity,taskId:selected.nodes.get('consumer')!.id})).toEqual(new Uint8Array([1,2,3]));
    await expect(readInputAsset(fs,{...input,bytes:99})).rejects.toThrow('metadata');
    await expect(importInputAsset(fs,'data:image/svg+xml;base64,AQID')).rejects.toThrow('Invalid');
    const inspect = kernel.inspectSession.bind(kernel), list = vi.fn();
    const cold = vi.spyOn(kernel, 'inspectSession').mockImplementation(async id => {
        const snapshot = await inspect(id);
        return {...snapshot, listTasks: () => {list(); return snapshot.listTasks();}};
    });
    const open = vi.spyOn(kernel, 'openSession');
    try {
        expect(await read(result.assets[0], identity)).toEqual(new Uint8Array([1, 2, 3]));
        expect(list).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
    } finally {cold.mockRestore(); open.mockRestore();}
    await expect(read(result.assets[0], { ...identity, taskId: other.nodes.get('consumer')!.id })).rejects.toThrow('another Flow');
    await expect(read({ ...result.assets[0], sessionId: 'other' }, identity)).rejects.toThrow('another Session');
    await expect(read({ ...result.assets[0], bytes: 4 }, identity)).rejects.toThrow('integrity');
});

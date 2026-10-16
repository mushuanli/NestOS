import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager } from '@itookit/vfs-core';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import type { ILLMService, LLMProvider } from '@itookit/driver-llm/contracts';
import { LlmMediaEffectAdapter, type LlmMediaEffectRequest } from './llm-media-effect';
import { createMediaResultStore, readMediaAsset } from './media-result-store';
import { mediaEndpointIdentity } from '../llm-management/contracts/model-requirements';
const managers: IVFSManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); });
async function fixture(taskId = 't') {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); managers.push(manager); const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: `/s/tasks/${taskId}`, name: 'task.seq', type: 'seqfile', recursive: true });
    const provider: LLMProvider = { id: 'p', name: 'P', baseURL: 'https://example.test', implementation: 'openai-compatible',
        media: { 'image.generate': { adapter: 'openai-images' } }, models: [{ id: 'image', name: 'Image', operations: {
            'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] },
        } }] };
    const connection = { id: 'c', name: 'C', providerId: 'p', model: 'image', enabled: true, hasApiKey: true };
    const generateMedia = vi.fn(async () => ({ model: 'image', assets: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }], usage: { total_tokens: 10 } }));
    const service = { getConnection: async () => connection, getProvider: async () => provider, generateMedia } as unknown as ILLMService;
    const store = createMediaResultStore(async () => ({ fs, rootPath: '/s' }));
    const context: EffectExecutionContext = { sessionId: 's', taskId, effectId: 'e', abortSignal: new AbortController().signal, chargeBudget: vi.fn(async () => []),
        grants: [{ handleId: 'h', right: 'execute', resource: { id: 'r', sessionId: 's', kind: 'llm', uri: 'llm://fixture', generation: 1, createdAt: 0 } }] };
    const request: LlmMediaEffectRequest = { resourceHandleId: 'h', connectionId: 'c', request: { operation: 'image.generate', model: 'image', prompt: 'A square', format: 'png' },
        connectionSnapshot: { providerId: 'p', modelId: 'image', mediaEndpoint: mediaEndpointIdentity(provider, undefined, 'image.generate') } };
    return { fs, store, context, request, provider, connection, generateMedia, service, adapter: new LlmMediaEffectAdapter(service, store) };
}
it('recovers verified local results without generation and settles usage with a stable identity', async () => {
    const f = await fixture(), result = await f.adapter.execute(f.request, f.context);
    expect(result.assets[0]).toMatchObject({ sessionId: 's', taskId: 't', mimeType: 'image/png', bytes: 3 });
    expect(result.assets[0]).not.toHaveProperty('data');
    expect(await new LlmMediaEffectAdapter(f.service, f.store).reconcile(f.request, f.context)).toEqual({ status: 'completed', result });
    expect(f.generateMedia).toHaveBeenCalledOnce();
    const charges = vi.mocked(f.context.chargeBudget!).mock.calls; expect(charges).toHaveLength(2); expect(charges[0][3]).toEqual(charges[1][3]);
    await f.fs.meta.assets.putAsset('/s/tasks/t/task.seq', result.assets[0].name, new Uint8Array([9]).buffer);
    await expect(f.adapter.reconcile(f.request, f.context)).rejects.toThrow('integrity');
});
it.each(['task space', '任务%名称', 'task:one'])('stores and recovers media in the actual Task file for %s', async taskId => {
    const f = await fixture(taskId), result = await f.adapter.execute(f.request, f.context);
    expect(result.assets[0].owner).toBe(`tasks/${taskId}/task.seq`);
    expect(await readMediaAsset(f.fs, '/s', result.assets[0], f.context)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await f.adapter.reconcile(f.request, f.context)).toEqual({ status: 'completed', result });
    expect(await f.fs.meta.seq!.getEntry(`/s/tasks/${taskId}/task.seq`, 'media-result/e')).toBeTruthy();
    expect(f.generateMedia).toHaveBeenCalledOnce();
    await expect(readMediaAsset(f.fs, '/s', result.assets[0], { ...f.context, taskId: 'another' })).rejects.toThrow('identity');
});

it.each(['../t', 'nested/task', '.', ''])('rejects invalid Task storage identity %s', async taskId => {
    const f = await fixture();
    await expect(f.store.put(f.request, await f.generateMedia(), { ...f.context, taskId })).rejects.toThrow('Invalid object ID');
});
it('keeps a lost receipt indeterminate and refuses changed or unavailable bindings', async () => {
    const f = await fixture();
    expect(await f.adapter.reconcile(f.request, f.context)).toMatchObject({ status: 'indeterminate' });
    expect(f.adapter.shouldRetry()).toBe(false);
    f.provider.baseURL = 'https://other.test'; await expect(f.adapter.execute(f.request, f.context)).rejects.toThrow('changed after admission');
    f.provider.baseURL = 'https://example.test'; f.connection.enabled = false; await expect(f.adapter.execute(f.request, f.context)).rejects.toThrow('unavailable');
    expect(f.generateMedia).not.toHaveBeenCalled();
});
it('applies host authorization and confirms cancellation only after the in-flight request stops', async () => {
    const f = await fixture(), denied = async () => { throw new Error('permission revoked'); };
    await expect(new LlmMediaEffectAdapter(f.service, f.store, denied).execute(f.request, f.context)).rejects.toThrow('permission revoked');
    let release!: () => void; f.generateMedia.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('aborted'); });
    const abort = new AbortController(), context = { ...f.context, abortSignal: abort.signal }, pending = f.adapter.execute(f.request, context);
    const failure = expect(pending).rejects.toThrow('aborted'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let stopped = false; const cancelled = f.adapter.cancel(f.request, context).then(() => { stopped = true; });
    abort.abort(); await Promise.resolve(); expect(stopped).toBe(false); release(); await failure; await cancelled; expect(stopped).toBe(true);
});

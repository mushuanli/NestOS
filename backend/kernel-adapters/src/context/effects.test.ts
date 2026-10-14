import { describe, expect, it, vi } from 'vitest';
import { createContextContentStore, createContextService } from '@itookit/llm-context';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { ContextLlmEffect, ContextPrepareEffect, ContextToolEffect } from './effects';

function fixture() {
    const blobs = new Map<string, string>();
    const content = createContextContentStore({ get: async id => blobs.get(id) ?? null,
        putIfAbsent: async (id, body) => { if (!blobs.has(id)) blobs.set(id, body); } });
    const service = createContextService({ content, records: { get: async () => undefined } });
    const context: EffectExecutionContext = { sessionId: 's', taskId: 't', effectId: 'e', abortSignal: new AbortController().signal,
        grants: [{ handleId: 'llm', right: 'execute', resource: { id: 'r', sessionId: 's', kind: 'llm', uri: 'llm://test', generation: 1, createdAt: 1 } }],
        emit: async () => {} };
    return { blobs, content, service, context };
}

describe('durable context effects', () => {
    it('refuses missing or corrupted request bytes before invoking the provider', async () => {
        const f = fixture();
        const prepared = await f.service.prepare({ contextId: 't', operationId: 'p', request: { model: 'model' }, messages: [{ role: 'user', content: 'goal' }] });
        const execute = vi.fn(async () => ({ choices: [] } as never));
        const effect = new ContextLlmEffect(async () => f.service, { kind: 'llm.chat', version: '1', execute });
        const request = { cursor: prepared.cursor, resourceHandleId: 'llm', connectionId: 'c' };
        await effect.execute(request, f.context);
        expect(execute.mock.calls[0][0]).toMatchObject({ request: { model: 'model', messages: [{ content: 'goal' }] } });
        f.blobs.set(prepared.cursor.snapshot.id, '{}');
        await expect(effect.execute(request, f.context)).rejects.toThrow('missing or corrupt');
        f.blobs.delete(prepared.cursor.snapshot.id);
        await expect(effect.execute(request, f.context)).rejects.toThrow('missing or corrupt');
        expect(execute).toHaveBeenCalledTimes(1);
        await expect(effect.execute({ ...request, cursor: { ...request.cursor, contextId: 'other' } }, f.context)).rejects.toThrow('owner');
        expect(await effect.reconcile()).toMatchObject({ status: 'indeterminate' });
    });

    it('does not publish preparation after cancellation and waits until local work stops', async () => {
        const f = fixture(); const controller = new AbortController();
        let release!: () => void;
        const blocker = new Promise<void>(resolve => { release = resolve; });
        const prepare = vi.fn(async () => { await blocker; return {} as never; });
        const effect = new ContextPrepareEffect(async () => ({ ...f.service, prepare }));
        const context = { ...f.context, abortSignal: controller.signal };
        const request = { resourceHandleId: 'llm', connectionId: 'c', messages: [], request: {} };
        const execution = effect.execute(request, context);
        const failed = expect(execution).rejects.toThrow('cancelled');
        await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
        controller.abort(new Error('cancelled'));
        let stopped = false;
        const cancellation = effect.cancel(request, context).then(() => { stopped = true; });
        await Promise.resolve(); expect(stopped).toBe(false);
        release(); await failed; await cancellation; expect(stopped).toBe(true);
    });

    it('preserves indeterminate external effects when output storage fails', async () => {
        const f = fixture();
        const execute = vi.fn(async () => ({ toolId: 'write', success: true, durationMs: 1, output: 'changed' }));
        const reconcile = vi.fn(async () => ({ status: 'indeterminate' as const, error: { message: 'Unknown external result' } }));
        const service = { ...f.service, admitOutput: async () => { throw new Error('storage offline'); } };
        const effect = new ContextToolEffect(async () => service, { kind: 'tool.call', version: '1', execute, reconcile });
        const context = { ...f.context, grants: [{ ...f.context.grants[0], resource: { ...f.context.grants[0].resource, kind: 'tool' } }] };
        const request = { resourceHandleId: 'llm', toolId: 'write', args: {} };
        await expect(effect.execute(request, context)).rejects.toThrow('storage offline');
        expect(await effect.reconcile(request, context)).toMatchObject({ status: 'indeterminate' });
        expect(execute).toHaveBeenCalledTimes(1);
    });
});

import { expect, it, vi } from 'vitest';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { SkillUnloadEffectAdapter } from './skill-unload-effect';

function context(): EffectExecutionContext {
    return { sessionId: 'session', taskId: 'task', effectId: 'effect', abortSignal: new AbortController().signal,
        grants: [{ handleId: 'skill-handle', right: 'execute', resource: {
            id: 'resource', sessionId: 'session', kind: 'skill', uri: 'skill://session', generation: 1, createdAt: 1,
        } }] };
}
const request = { resourceHandleId: 'skill-handle', skillId: 'review' };

it('rejects absent grants or shared-state persistence before live unload', async () => {
    const unloadSkill = vi.fn(), service = { unloadSkill } as never;
    const adapter = new SkillUnloadEffectAdapter(service), ctx = context();
    await expect(adapter.execute(request, { ...ctx, grants: [] })).rejects.toThrow();
    await expect(adapter.execute(request, ctx)).rejects.toThrow('requires Session shared state');
    ctx.sessionState = { get: async () => ({ value: ['review'], version: 1 }), set: async () => { throw new Error('storage unavailable'); } } as never;
    await expect(adapter.execute(request, ctx)).rejects.toThrow('storage unavailable');
    expect(unloadSkill).not.toHaveBeenCalled();
});

it('retries live cleanup after durable removal without restoring or rewriting the removed identity', async () => {
    let ids = ['review', 'keep'];
    const set = vi.fn(async (_key, value) => { ids = value; return { value, version: 2 }; });
    const unloadSkill = vi.fn().mockRejectedValueOnce(new Error('cleanup interrupted')).mockResolvedValue(undefined);
    const adapter = new SkillUnloadEffectAdapter({ unloadSkill } as never), ctx = context();
    ctx.sessionState = { get: async () => ({ value: ids, version: 1 }), set } as never;
    await expect(adapter.execute(request, ctx)).rejects.toThrow('cleanup interrupted');
    expect(ids).toEqual(['keep']);
    expect(await adapter.reconcile()).toEqual({ status: 'retry' });
    await expect(adapter.execute(request, ctx)).resolves.toEqual({ skillId: 'review', unloaded: true });
    expect(set).toHaveBeenCalledTimes(1);
    expect(unloadSkill).toHaveBeenCalledTimes(2);
});

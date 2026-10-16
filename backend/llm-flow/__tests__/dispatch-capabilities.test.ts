import { expect, it, vi } from 'vitest';
import type { SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import { reconcileDispatchChildren } from '../src/flow/structured/reconcile';

it.each([
    ['kernel-adapters.tool', 'tool', 'toolHandleId', ['tool-a']],
    ['kernel-adapters.media', 'llm', 'llmHandleId', []],
    ['llm.agent', 'llm', 'llmHandleId', []],
] as const)('binds capabilities before starting a dispatched %s child', async (kind, resourceKind, signalKey, capabilities) => {
    const start = vi.fn(), createResource = vi.fn(async () => ({ handle: { id: 'resource' } }));
    const handle = { id: 'child', start, createResource } as unknown as TaskHandle;
    const session = {
        listTasks: async () => [
            { id: 'owner', program: { kind: 'flow.dispatch' }, status: 'running', input: {
                branches: [{ key: 'branch', target: { capabilities, budget: { tokens: 10 } } }],
            } },
            { id: 'child', parentTaskId: 'owner', labels: { dispatchKey: 'branch' }, program: { kind }, status: 'created' },
        ],
        attachTask: async () => handle,
        setBudget: vi.fn(),
    } as unknown as SessionHandle;
    expect(await reconcileDispatchChildren(session, [{ id: 'owner' } as TaskHandle], vi.fn(), 1)).toBe(1);
    expect(createResource).toHaveBeenCalledTimes(1);
    expect(createResource).toHaveBeenCalledWith(expect.objectContaining({ kind: resourceKind }));
    expect(start).toHaveBeenCalledWith({ signal: { type: 'capabilities', payload: { [signalKey]: 'resource' } } });
    if (resourceKind === 'llm') expect(session.setBudget).toHaveBeenCalledWith('resource', 'tokens', 10);
});

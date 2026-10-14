import { expect, it, vi } from 'vitest';
import { GraphRetryController, type GraphRetryState } from '../src/flow/graph-retry-controller';
import { createSchedulerCollections, snapshotSchedulerCollections } from '../src/flow/scheduler-state';
import { decodeSchedulerCheckpoint } from '../src/flow/checkpoint-decoder';
import type { TaskHandle } from '@itookit/durable-kernel';

it('restores the retry receipt after a crash between checkpoint and acknowledgement', async () => {
    const spec = { nodes: [], edges: [] };
    const collections = createSchedulerCollections(spec, undefined, new Set());
    const queue = [{ version: 1, requestId: 'request', sourceTaskId: 'old', retryTaskId: 'retry', sourceNodeId: 'a', downstream: ['b'] }];
    const retry = { id: 'retry' } as TaskHandle;
    const session = { getShared: vi.fn(async () => ({ value: queue, version: 1 })), attachTask: vi.fn(async () => retry),
        setShared: vi.fn(async () => { throw new Error('crash before ack'); }) };
    let saved: unknown;
    const state: GraphRetryState = {
        session: session as never, run: { root: { id: 'root' }, nodes: new Map(), iterations: new Map(), taskIds: new Set() },
        nodes: [], edges: [], instances: new Map(), completed: new Set(), skipped: new Set(), detachedNodes: new Set(),
        groups: new Map(), depths: new Map(), groupByChild: new Map(), nodeGenerations: collections.nodeGenerations,
        appliedGraphRetries: collections.appliedGraphRetries, nodeDefaults: new Map(), nodeConnections: new Map(),
        edgeState: new Map(), routeEdgeIds: new Set(), variables: collections.variableStore, refund: vi.fn(),
        persist: async () => { saved = snapshotSchedulerCollections(collections, state.instances, state.completed,
            { spec, nodeDefaults: [], nodeConnections: [], consumedTokens: 0, startedAt: 1 }); },
    };
    await expect(new GraphRetryController(state).consume()).rejects.toThrow('crash before ack');
    expect(state.nodeGenerations.get('b')).toBe(1);
    const restored = createSchedulerCollections(spec, decodeSchedulerCheckpoint(saved), new Set());
    state.appliedGraphRetries = restored.appliedGraphRetries;
    state.nodeGenerations = restored.nodeGenerations;
    session.setShared = vi.fn(async () => undefined);
    session.attachTask.mockClear();
    await new GraphRetryController(state).consume();
    expect(state.nodeGenerations.get('b')).toBe(1);
    expect(session.attachTask).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
    expect(session.setShared).toHaveBeenCalledOnce();
});

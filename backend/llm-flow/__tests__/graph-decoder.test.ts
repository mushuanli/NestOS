import { expect, it } from 'vitest';
import { graphEffects } from '../src/flow/graph-decoder';
import { decodeSchedulerCheckpoint } from '../src/flow/checkpoint-decoder';
import { createSchedulerCollections, snapshotSchedulerCollections } from '../src/flow/scheduler-state';

it.each([null, { type: 'unknown' }, { type: 'cancel-tasks', tasks: [null], reason: 'cancel' },
    { type: 'activate-edge', edgeId: 1 }, { type: 'patch-graph', patch: { idempotencyKey: 'x', nodes: [null], edges: [] } }])
('rejects invalid graph effect batches before returning any valid prefix: %j', bad => {
    expect(() => graphEffects({ effects: [{ type: 'disable-edge', edgeId: 'valid' }, bad] })).toThrow('Invalid Flow graph effects');
});
it('accepts plain outputs and validates scheduler collections before recovery', () => {
    expect(graphEffects({ result: 'plain' })).toEqual([]);
    const spec = { nodes: [], edges: [] };
    const saved = snapshotSchedulerCollections(createSchedulerCollections(spec, undefined, new Set()), new Map(), new Set(),
        { spec, consumedTokens: 0, startedAt: 1, nodeDefaults: [], nodeConnections: [] });
    expect(decodeSchedulerCheckpoint(saved)).toEqual(saved);
    expect(() => decodeSchedulerCheckpoint({ ...saved, instances: [['a', null]] })).toThrow('Invalid Flow scheduler checkpoint');
    expect(() => decodeSchedulerCheckpoint({ ...saved, appliedGraphRetries: [42] })).toThrow('Invalid Flow scheduler checkpoint');
    expect(() => decodeSchedulerCheckpoint({ ...saved, catalog: { manifests: [], schemas: null } })).toThrow('Invalid Flow scheduler checkpoint');
    expect(() => decodeSchedulerCheckpoint({ ...saved, nodeConnections: [['a', { connections: [null] }]] })).toThrow('Invalid Flow scheduler checkpoint');
});

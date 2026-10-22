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
    expect(() => decodeSchedulerCheckpoint({ ...saved, instances: [['a', null]] })).toThrow('Invalid Flow scheduler checkpoint: instances');
    expect(() => decodeSchedulerCheckpoint({ ...saved, appliedGraphRetries: [42] })).toThrow('Invalid Flow scheduler checkpoint');
    expect(() => decodeSchedulerCheckpoint({ ...saved, catalog: { manifests: [], schemas: null } })).toThrow('Invalid Flow scheduler checkpoint');
    expect(() => decodeSchedulerCheckpoint({ ...saved, nodeConnections: [['a', { connections: [null] }]] })).toThrow('Invalid Flow scheduler checkpoint: nodeConnections');
});

it('accepts unbound optional slots without accepting malformed connection identities', () => {
    const spec = { nodes: [], edges: [] };
    const scope = { connections: [{ name: 'text', connectionId: 'bound' }, { name: 'image', required: false }] };
    const saved = snapshotSchedulerCollections(createSchedulerCollections(spec, undefined, new Set()), new Map(), new Set(),
        { spec, consumedTokens: 0, startedAt: 1, nodeDefaults: [], nodeConnections: [['a', scope]] });
    expect(decodeSchedulerCheckpoint(saved)).toEqual(saved);
    for (const connectionId of [null, '', 42]) {
        const nodeConnections = [['a', { connections: [{ name: 'image', required: false, connectionId }] }]];
        expect(() => decodeSchedulerCheckpoint({ ...saved, nodeConnections })).toThrow('Invalid Flow scheduler checkpoint: nodeConnections');
    }
});

it('rejects malformed frozen function templates and parameter-set scope indices on recovery', () => {
    const spec = { nodes: [], edges: [] };
    const saved = snapshotSchedulerCollections(createSchedulerCollections(spec, undefined, new Set()), new Map(), new Set(),
        { spec, consumedTokens: 0, startedAt: 1, nodeDefaults: [], nodeConnections: [] });
    const template = { child: spec, collector: 'calls/__flow_return', maxConcurrency: 1 };
    expect(decodeSchedulerCheckpoint({ ...saved, spec: { ...spec, functionCalls: { calls__input: template } } })).toBeDefined();
    for (const invalid of [null, [], { ...template, maxConcurrency: 0 }, { ...template, maxConcurrency: 1.5 },
        { ...template, collector: '' }, { ...template, child: { nodes: [null], edges: [] } }]) {
        expect(() => decodeSchedulerCheckpoint({ ...saved, spec: { ...spec, functionCalls: { calls__input: invalid } } })).toThrow('checkpoint: spec');
    }
    for (const parameterSet of [-1, 0.5, '0', null]) {
        const parameterScopes = { 'calls/0/': { parent: '', source: 'calls__input', parameterSet, defaults: {}, values: {} } };
        expect(() => decodeSchedulerCheckpoint({ ...saved, spec: { ...spec, parameterScopes } })).toThrow('checkpoint: spec');
    }
});

it('rejects malformed runtime input snapshots while keeping legacy missing input compatible', () => {
    const spec = { nodes: [], edges: [] };
    const saved = snapshotSchedulerCollections(createSchedulerCollections(spec, undefined, new Set()), new Map(), new Set(),
        { spec, consumedTokens: 0, startedAt: 1, nodeDefaults: [], nodeConnections: [] });
    expect(decodeSchedulerCheckpoint(saved)).toBeDefined();
    expect(decodeSchedulerCheckpoint({ ...saved, spec: { ...spec, input: { prompt: '${param.private}' } } })).toBeDefined();
    for (const input of [null, {}, [], { prompt: 1 }, { prompt: null }, { prompt: 'private', unknown: true }]) {
        expect(() => decodeSchedulerCheckpoint({ ...saved, spec: { ...spec, input } })).toThrow('checkpoint: spec');
    }
});

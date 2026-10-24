import { afterEach, beforeEach, expect, it } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms, flowToDag } from '../src/flow';
import { decodeSchedulerCheckpoint } from '../src/flow/checkpoint-decoder';
import { recordFlowSkip, restoreFlowSkips, serializeFlowSkips, clearFlowSkip } from '../src/flow/skip-state';
import type { FlowRevision, FlowNodeDefinition, HarnessHookContext } from '../src/contracts';

const value = (id: string): FlowNodeDefinition => ({ id: id as never, name: id,
    plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: id } });
const definition = (id: string, nodes: FlowNodeDefinition[], edges: FlowRevision['edges'] = []): FlowRevision => ({
    id: id as never, name: id, revision: 1, digest: id, createdAt: 0, nodes, edges,
});
function branchFlow(): FlowRevision {
    return definition('skip-reasons', [value('merge'), value('unused-tail'), value('unused'),
        value('selected'), { ...value('route'), plugin: 'builtin.route', config: {
            rules: [{ edgeId: 'selected', expression: { kind: 'literal', value: true } }], defaultEdgeId: 'unused',
        } }], [
        { id: 'selected', from: 'route', to: 'selected' }, { id: 'unused', from: 'route', to: 'unused' },
        { id: 'unused-tail', from: 'unused', to: 'unused-tail' },
        { id: 'selected-merge', from: 'selected', to: 'merge' }, { id: 'unused-merge', from: 'unused-tail', to: 'merge' },
    ] as FlowRevision['edges']);
}

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
const hookEvents: HarnessHookContext[] = [];
beforeEach(async () => {
    hookEvents.length = 0;
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/data/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(),
        hooks: { descriptor: { source: 'test-hooks', contentHash: 'test', trusted: true },
            emit: async context => { hookEvents.push(context); } } });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

it('records why each unselected node never ran and keeps the run successful', async () => {
    const flow = branchFlow();
    flow.outputs = { result: { value: '${nodes.merge.outputs.result}' } };
    const run = await executor.submit('s', await flowToDag(flow, undefined, undefined, async () => flow));
    const exit = await run.root.wait({ timeoutMs: 3000 });
    expect(exit.status).toBe('succeeded');
    const skipped = (exit.output as { skipped?: Array<Record<string, unknown>> }).skipped ?? [];
    expect(skipped).toContainEqual({ nodeId: 'unused', reason: 'branch-not-selected', iteration: 1,
        cause: { nodeId: 'route', edgeId: 'unused' } });
    expect(skipped).toContainEqual({ nodeId: 'unused-tail', reason: 'upstream-skipped', iteration: 1,
        cause: { nodeId: 'unused', edgeId: 'unused-tail' } });
    expect(skipped.map(item => item.nodeId)).not.toContain('selected');
    expect(skipped.map(item => item.nodeId)).not.toContain('merge');
});

it('reports each skip as a node.skipped hook event exactly once', async () => {
    const flow = branchFlow();
    flow.outputs = { result: { value: '${nodes.merge.outputs.result}' } };
    const run = await executor.submit('s', await flowToDag(flow, undefined, undefined, async () => flow));
    await run.root.wait({ timeoutMs: 3000 });
    const skips = hookEvents.filter(event => event.event === 'node.skipped');
    expect(skips.map(event => (event.payload as { nodeId: string }).nodeId).sort()).toEqual(['unused', 'unused-tail']);
    const branchSkip = skips.find(event => (event.payload as { nodeId: string }).nodeId === 'unused')!;
    expect(branchSkip.payload).toMatchObject({ reason: 'branch-not-selected', iteration: 1, causeNodeId: 'route',
        causeEdgeId: 'unused', stage: 'skip', result: 'skipped' });
    expect(skips.every(event => event.sessionId === 's')).toBe(true);
});

it('keeps skip reasons recoverable from the persisted checkpoint', async () => {
    const flow = branchFlow();
    flow.outputs = { result: { value: '${nodes.merge.outputs.result}' } };
    const run = await executor.submit('s', await flowToDag(flow, undefined, undefined, async () => flow));
    await run.root.wait({ timeoutMs: 3000 });
    const restored = await executor.resume('s', run.root.id);
    expect(restored.nodes.has('unused')).toBe(false);
    const again = await restored.root.wait({ timeoutMs: 3000 });
    const skipped = (again.output as { skipped?: Array<Record<string, unknown>> }).skipped ?? [];
    expect(skipped.map(item => item.reason)).toContain('branch-not-selected');
});

it('keeps the deciding reason and clears it only on activation', () => {
    const records = restoreFlowSkips(undefined);
    recordFlowSkip(records, 'n1', { reason: 'branch-not-selected', iteration: 1, cause: { nodeId: 'route', edgeId: 'e1' } });
    recordFlowSkip(records, 'n1', { reason: 'upstream-skipped', iteration: 2 });
    expect([...records.values()]).toEqual([{ reason: 'branch-not-selected', iteration: 1, cause: { nodeId: 'route', edgeId: 'e1' } }]);
    clearFlowSkip(records, 'n1');
    expect(serializeFlowSkips(records)).toEqual([]);
});

it('accepts legacy checkpoints without skip records and rejects malformed ones', () => {
    const envelope = { version: 1, nodes: [], edges: [], spec: { nodes: [], edges: [] }, instances: [],
        edgeState: [], delegationDepth: [], delegationGroups: [], delegationGroupByChild: [], appliedPatches: [],
        nodeDefaults: [], nodeConnections: [], consumedTokens: 0, startedAt: 0, completed: [], skipped: [],
        detachedNodes: [], completionOrder: [], dispatchOrder: [] };
    expect(decodeSchedulerCheckpoint(envelope)).toBeDefined();
    expect(decodeSchedulerCheckpoint({ ...envelope, skipped: ['n1'],
        skipRecords: [['n1', { reason: 'upstream-skipped', iteration: 1 }]] })).toBeDefined();
    expect(() => decodeSchedulerCheckpoint({ ...envelope,
        skipRecords: [['n1', { reason: 'business-reason', iteration: 1 }]] })).toThrow(/skipRecords/);
    expect(() => decodeSchedulerCheckpoint({ ...envelope,
        skipRecords: [['n1', { reason: 'upstream-skipped', iteration: 0 }]] })).toThrow(/skipRecords/);
});

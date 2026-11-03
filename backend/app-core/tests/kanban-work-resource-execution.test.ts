import {expect, it, vi} from 'vitest';
import {workResourceExecution} from '../src/presets/kanban-work-resource-execution';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {durableState, request} from './harness-execution-fixture';
import {context, operation} from './harness-context-fixture';

async function fixture() {
    const saved = durableState(), store = new HarnessContextBindings(saved.state, 'child');
    await store.claim('binding', context, {...request.connection, id: 'work-ready'}, operation);
    await store.attach('binding', operation.operationId, {nodeConnectionId: 'node', profileId: 'codex', workspaceId: 'workspace', epoch: 'epoch', sessionId: 'native'});
    const staged = await store.prepareSettlement('binding', operation.operationId, {operationId: operation.operationId, kind: 'terminal', knownHeadRef: 'turn'});
    await store.release('binding', operation.operationId, staged.revision + 1);
    const snapshot = {active: false, pending: undefined, requests: [], draft: '', controls: [], instructionQueue: {items: []},
        observation: {stale: false, connection: 'online', receiptUnknown: false, execution: 'idle'}};
    const view = {read: vi.fn(async () => {}), snapshot: () => snapshot, close: vi.fn(async () => {})};
    const call = {callerState: {settled: true}, executionTree: {settled: true}, receipt: {executionSessionId: 'child'}};
    const options = {journal: {get: vi.fn(async () => undefined)}, calls: {list: vi.fn(async () => [call])},
        kernel: {inspectSession: vi.fn(async () => ({getShared: saved.state.get}))}, remote: {projectConversation: vi.fn(async () => view)}} as never;
    return {options, snapshot, view, call};
}
it('requires native terminal evidence and uses a read-only view without acquiring a writer', async () => {
    const f = await fixture(); expect(await workResourceExecution(f.options, 'ready', 'project')).toEqual([]);
    expect((f.options as any).remote.projectConversation).toHaveBeenCalledWith('project', 'codex', 'native', undefined, true);
    expect(f.view.close).toHaveBeenCalledOnce(); f.snapshot.active = true;
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_IN_USE');
    f.snapshot.active = false; f.snapshot.draft = 'Pending user input';
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_IN_USE');
    f.snapshot.draft = ''; f.snapshot.observation.stale = true;
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_EXECUTION_UNKNOWN');
});
it('fails closed for missing calls or unsettled execution trees without opening a native conversation', async () => {
    const f = await fixture(); f.call.executionTree.settled = false;
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_IN_USE');
    expect((f.options as any).remote.projectConversation).not.toHaveBeenCalled();
    (f.options as any).calls.list.mockResolvedValue([]);
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_EXECUTION_UNKNOWN');
});

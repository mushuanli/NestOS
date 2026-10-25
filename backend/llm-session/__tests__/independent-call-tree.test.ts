import {expect, it, vi} from 'vitest';
import {taskStat, type Kernel, type TaskRecord} from '@itookit/durable-kernel';
import {readIndependentCallTree} from '../src/session/independent-call-tree';
function task(id: string, parentTaskId?: string, rootTaskId = 'root'): TaskRecord {
    return {id, sessionId: 'child', parentTaskId, rootTaskId, version: 1, status: 'succeeded', exit: {kind: 'succeeded'}, effects: {},
        labels: {}, interactions: {}, program: {kind: 'fixture'}, input: {secret: 'PRIVATE INPUT'}, output: 'PRIVATE OUTPUT'} as unknown as TaskRecord;
}
function fixture(tasks: TaskRecord[]) {
    const snapshot = vi.fn(async () => ({session: {id: 'child'}, tasks, asOfSequence: 42}));
    const inspectSession = vi.fn(async () => ({snapshot}));
    return {kernel: {inspectSession} as unknown as Kernel, snapshot};
}
it('keeps a terminal root unsettled while a descendant operation is still being cleaned', async () => {
    const root = task('root'), child = task('worker', 'root');
    child.effects = {operation: {status: 'succeeded', cleanupPending: true}} as TaskRecord['effects'];
    const f = fixture([root, child]); const result = await readIndependentCallTree(f.kernel, root);
    expect(taskStat(result.task).settled).toBe(true);
    expect(result.tree).toEqual({taskId: 'root', asOfSequence: 42, tasks: 2, unsettledTasks: 1, activeOperations: 1, settled: false, stopped: false});
    expect(f.snapshot).toHaveBeenCalledOnce(); expect(JSON.stringify(result.tree)).not.toContain('PRIVATE');
    child.effects = {}; expect((await readIndependentCallTree(f.kernel, root)).tree.settled).toBe(true);
});
it('includes only actual descendants of a selected subtask, excluding siblings and other roots', async () => {
    const root = task('branch', 'root'), sibling = task('sibling', 'root'); sibling.exit = undefined;
    const other = task('other', undefined, 'other'); other.exit = undefined;
    const result = await readIndependentCallTree(fixture([task('root'), root, task('leaf', 'branch'), sibling, other]).kernel, root);
    expect(result.tree).toMatchObject({tasks: 2, unsettledTasks: 0, activeOperations: 0, settled: true});
});
it('uses root state from the same atomic snapshot as the children', async () => {
    const expected = task('root'), current = {...expected, version: 2, exit: undefined, status: 'running'} as TaskRecord;
    const result = await readIndependentCallTree(fixture([current]).kernel, expected);
    expect(taskStat(result.task)).toMatchObject({revision: 2, phase: 'running'}); expect(result.tree.settled).toBe(false);
});
it.each(['missing', 'cycle', 'root-cycle', 'wrong-root', 'identity'])('rejects %s tree inconsistencies rather than claiming settlement', async scenario => {
    const root = task('root'), child = task('child', 'root'); let tasks = [root, child];
    if (scenario === 'missing') child.parentTaskId = 'missing';
    if (scenario === 'cycle') {child.parentTaskId = 'leaf'; tasks.push(task('leaf', 'child'));}
    if (scenario === 'root-cycle') root.parentTaskId = 'child';
    if (scenario === 'wrong-root') child.rootTaskId = 'other';
    if (scenario === 'identity') tasks = [{...root, labels: {invocationId: 'foreign'}}, child];
    await expect(readIndependentCallTree(fixture(tasks).kernel, root)).rejects.toHaveProperty('code', 'CALL_EXECUTION_TREE_INVALID');
});

it('does not revive pending requests left on terminal tasks when reusing the tree snapshot', async () => {
    const root = task('root'), child = task('child', 'root');
    child.interactions = {ask: {id: 'ask', kind: 'input', status: 'pending', prompt: 'Old question', requestedAt: 1}};
    const result = await readIndependentCallTree(fixture([root, child]).kernel, root);
    expect(result.interactions).toEqual({items: [], total: 0});
    child.exit = undefined; child.status = 'blocked';
    expect((await readIndependentCallTree(fixture([root, child]).kernel, root)).interactions.total).toBe(1);
});

it('bounds unsettled descendant controls from the same snapshot without exposing Task payloads', async () => {
    const root = task('root');
    const children = Array.from({length: 55}, (_, index) => {
        const child = task(`worker-${String(index).padStart(2, '0')}`, 'root');
        child.exit = undefined; child.status = 'created'; child.control = {mode: 'pause', epoch: index + 1, requestId: `pause-${index}`, acknowledged: true}; return child;
    });
    const result = await readIndependentCallTree(fixture([root, ...children, task('settled', 'root')]).kernel, root);
    expect(result.descendants.total).toBe(55); expect(result.descendants.items).toHaveLength(50);
    expect(result.descendants.items[0]).toMatchObject({taskId: 'worker-00', parentTaskId: 'root', cancel: true,
        executionState: {id: 'worker-00', phase: 'waiting', controlEpoch: 1}});
    expect(result.descendants.items[49].taskId).toBe('worker-49');
    expect(JSON.stringify(result.descendants)).not.toContain('PRIVATE');
    const unsupported = task('old-flow', 'root'); unsupported.program.kind = 'flow.aggregate'; unsupported.exit = undefined;
    expect((await readIndependentCallTree(fixture([root, unsupported]).kernel, root)).descendants.items[0].cancel).toBe(false);
});

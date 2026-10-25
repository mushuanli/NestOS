import {summarizeIndependentCallInteractions} from './independent-call-interactions';
import {taskStat, type Kernel, type TaskRecord} from '@itookit/durable-kernel';
import type {IndependentCallExecutionTreeState, IndependentCallInteractions} from '../contracts/independent-calls';

/** One existing Kernel transaction supplies both root and descendant execution facts. */
export async function readIndependentCallTree(kernel: Kernel, expected: TaskRecord): Promise<{task: TaskRecord; tree: IndependentCallExecutionTreeState; interactions: IndependentCallInteractions}> {
    const snapshot = await (await kernel.inspectSession(expected.sessionId)).snapshot();
    const known = new Map(snapshot.tasks.map(task => [task.id, task]));
    const root = known.get(expected.id);
    if (!root || root.sessionId !== expected.sessionId || root.rootTaskId !== expected.rootTaskId
        || root.labels?.invocationId !== expected.labels?.invocationId) throw invalid();
    validateRoot(root, known);
    const selected: TaskRecord[] = [];
    const members = new Map<string, boolean>([[root.id, true]]);
    const tree: IndependentCallExecutionTreeState = {taskId: root.id, asOfSequence: snapshot.asOfSequence,
        tasks: 0, unsettledTasks: 0, activeOperations: 0, stopped: true, settled: true};
    for (const task of snapshot.tasks) {
        if (task.sessionId !== root.sessionId) throw invalid();
        if (task.parentTaskId && known.get(task.parentTaskId)?.rootTaskId !== task.rootTaskId) throw invalid();
        if (task.rootTaskId !== root.rootTaskId || !belongs(task, root, known, members)) continue;
        selected.push(task); const stat = taskStat(task); tree.tasks++; tree.activeOperations += stat.activeOperations;
        if (!stat.settled) tree.unsettledTasks++;
        tree.stopped &&= stat.stopped; tree.settled &&= stat.settled;
    }
    return {task: root, tree, interactions: summarizeIndependentCallInteractions(selected)};
}
function validateRoot(root: TaskRecord, known: Map<string, TaskRecord>): void {
    const seen = new Set<string>(); let task = root;
    while (task.id !== root.rootTaskId) {
        if (seen.has(task.id) || !task.parentTaskId) throw invalid();
        seen.add(task.id);
        const parent = known.get(task.parentTaskId);
        if (!parent || parent.sessionId !== root.sessionId || parent.rootTaskId !== root.rootTaskId) throw invalid();
        task = parent;
    }
    if (task.parentTaskId) throw invalid();
}
function belongs(task: TaskRecord, root: TaskRecord, known: Map<string, TaskRecord>, members: Map<string, boolean>): boolean {
    const path = new Set<string>(); let cursor = task;
    while (!members.has(cursor.id)) {
        if (path.has(cursor.id)) throw invalid();
        path.add(cursor.id);
        if (!cursor.parentTaskId) {
            if (cursor.id !== root.rootTaskId) throw invalid();
            members.set(cursor.id, false); break;
        }
        const parent = known.get(cursor.parentTaskId);
        if (!parent || parent.sessionId !== root.sessionId || parent.rootTaskId !== root.rootTaskId) throw invalid();
        cursor = parent;
    }
    const included = members.get(cursor.id)!;
    for (const id of path) members.set(id, included);
    return included;
}
function invalid(): Error {return Object.assign(new Error('CALL_EXECUTION_TREE_INVALID'), {code: 'CALL_EXECUTION_TREE_INVALID'});}

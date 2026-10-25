import type {Kernel, TaskRecord} from '@itookit/durable-kernel';

export async function belongsToCall(root: TaskRecord, candidate: TaskRecord, read: (id: string) => Promise<TaskRecord>, treeError: string): Promise<boolean> {
    const seen = new Set<string>(); let task = candidate;
    while (task.sessionId === root.sessionId && task.rootTaskId === root.rootTaskId) {
        if (task.id === root.id) return true;
        if (!task.parentTaskId) return false;
        if (seen.has(task.id)) throw Object.assign(new Error(treeError), {code: treeError});
        seen.add(task.id); task = await read(task.parentTaskId);
    }
    return false;
}


/** Parent links, not a shared root label, authorize access to a call's descendants. */
export async function readCallMember(kernel: Kernel, root: TaskRecord, taskId: string, errors: {tree: string; scope: string}): Promise<TaskRecord> {
    const session = await kernel.inspectSession(root.sessionId);
    const read = async (id: string) => (await (await session.attachTask(id)).status()).task;
    const target = await read(taskId);
    if (!await belongsToCall(root, target, read, errors.tree)) throw Object.assign(new Error(errors.scope), {code: errors.scope});
    return target;
}

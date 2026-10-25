import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import type {IndependentCallInteractions} from '../contracts/independent-calls';

/** Read only the pending index; Session membership alone never grants call membership. */
export async function readIndependentCallInteractions(kernel: Kernel, root: TaskRecord): Promise<IndependentCallInteractions> {
    const session = await kernel.inspectSession(root.sessionId), tasks = await session.listPendingInteractionTasks();
    const known = new Map<string, TaskRecord>([[root.id, root], ...tasks.map(task => [task.id, task] as const)]);
    const read = async (id: string) => {
        const cached = known.get(id); if (cached) return cached;
        const task = (await (await session.attachTask(id)).status()).task; known.set(id, task); return task;
    };
    const selected: TaskRecord[] = [];
    for (const task of tasks) if (await belongsTo(root, task, read)) selected.push(task);
    return summarizeIndependentCallInteractions(selected);
}
export function summarizeIndependentCallInteractions(tasks: TaskRecord[]): IndependentCallInteractions {
    const items: IndependentCallInteractions['items'] = []; let total = 0;
    for (const task of tasks.filter(task => !task.exit && !['succeeded', 'failed', 'cancelled'].includes(task.status))) for (const interaction of Object.values(task.interactions)) {
        if (interaction.status !== 'pending') continue;
        total++;
        if (items.length < 50) items.push({taskId: task.id, interactionId: interaction.id, kind: interaction.kind,
            prompt: interaction.prompt.slice(0, 1024), promptTruncated: interaction.prompt.length > 1024, requestedAt: interaction.requestedAt});
    }
    return {items, total};
}
async function belongsTo(root: TaskRecord, candidate: TaskRecord, read: (id: string) => Promise<TaskRecord>): Promise<boolean> {
    const seen = new Set<string>(); let task = candidate;
    while (task.sessionId === root.sessionId && task.rootTaskId === root.rootTaskId) {
        if (task.id === root.id) return true;
        if (!task.parentTaskId) return false;
        if (seen.has(task.id)) throw Object.assign(new Error('CALL_INTERACTION_TREE_INVALID'), {code: 'CALL_INTERACTION_TREE_INVALID'});
        seen.add(task.id); task = await read(task.parentTaskId);
    }
    return false;
}

export async function readIndependentCallInteractionTask(kernel: Kernel, root: TaskRecord, taskId: string): Promise<TaskRecord> {
    const session = await kernel.inspectSession(root.sessionId);
    const read = async (id: string) => (await (await session.attachTask(id)).status()).task;
    const target = await read(taskId);
    if (!await belongsTo(root, target, read)) throw Object.assign(new Error('CALL_INTERACTION_SCOPE_MISMATCH'), {code: 'CALL_INTERACTION_SCOPE_MISMATCH'});
    return target;
}

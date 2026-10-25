import {belongsToCall, readCallMember} from './independent-call-membership';
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
    for (const task of tasks) if (await belongsToCall(root, task, read, 'CALL_INTERACTION_TREE_INVALID')) selected.push(task);
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

export async function readIndependentCallInteractionTask(kernel: Kernel, root: TaskRecord, taskId: string): Promise<TaskRecord> {
    return readCallMember(kernel, root, taskId, {tree: 'CALL_INTERACTION_TREE_INVALID', scope: 'CALL_INTERACTION_SCOPE_MISMATCH'});
}

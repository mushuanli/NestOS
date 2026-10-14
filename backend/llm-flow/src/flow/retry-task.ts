import { isSchedulerOwnershipLost } from './scheduler-lease';
import type { SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import { prepareFlowTaskRetry, readFlowRunMembers } from './run-members';
import { bindFlowTaskCapabilities } from './task-capabilities';

/** Execute a fresh Task attempt; historical root output and downstream Tasks remain immutable. */
export async function retryFlowTask(session: SessionHandle, rootId: string, sourceId: string, requestId: string): Promise<TaskHandle> {
    const retry = await prepareFlowTaskRetry(session, rootId, sourceId, requestId);
    const task = (await retry.status()).task;
    if (task.status !== 'created') return retry;
    const root = (await (await session.attachTask(rootId)).status()).task;
    const member = (await readFlowRunMembers(session, root)).find(entry => entry.taskId === retry.id)!;
    const input = task.input as { allowedToolIds?: unknown } | undefined;
    const allowed = Array.isArray(input?.allowedToolIds) ? input.allowedToolIds.filter((id): id is string => typeof id === 'string') : [];
    try {
        await bindFlowTaskCapabilities(session, retry, task.program.kind, allowed, member.budget);
        if (task.program.kind !== 'llm.agent' && task.program.kind !== 'llm.chat') await retry.start();
    } catch (error) {
        if (isSchedulerOwnershipLost(error)) throw error;
        if ((await retry.status()).task.status === 'created') throw error;
    }
    return retry;
}

import type {SessionHandle, TaskHandle, TaskRecord} from '@itookit/durable-kernel';
import {flowControlError, flowTaskHeld, hasFlowControlTree, isPausedParentAdmission} from './control-tree';

/** Keep the Kernel retry identity; only versioned Runs add the owning control parent. */
export async function submitFlowRetry(session: SessionHandle, root: TaskRecord, sourceId: string, requestId: string): Promise<TaskHandle> {
    const original = await session.attachTask(sourceId), identity = `${root.id}:${requestId}`;
    if (!hasFlowControlTree(root)) return original.retry({requestId: identity});
    if (flowTaskHeld(root)) throw pausedRetry();
    const source = (await original.status()).task;
    try {
        return await session.submit({
            requestId: `retry:${JSON.stringify([sourceId, identity])}`, retryOfTaskId: sourceId,
            parent: root.id, program: source.program, input: source.input,
            dependsOn: source.dependencies, retry: source.retry, priority: source.priority,
            labels: source.labels, deferStart: true,
        });
    } catch (error) {
        if (isPausedParentAdmission(error) && !(await (await session.attachTask(root.id)).poll())) throw pausedRetry();
        throw error;
    }
}

function pausedRetry(): Error {
    return flowControlError('FLOW_RUN_PAUSED', 'Resume the owning Run or Session before retrying; reuse the same requestId');
}

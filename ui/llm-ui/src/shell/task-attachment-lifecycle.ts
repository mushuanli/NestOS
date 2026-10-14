import type { JsonValue } from '@itookit/durable-kernel/contracts';
import type { EditorTaskControlPlane } from '@itookit/durable-kernel/contracts';
import type { RunAttachmentController } from './RunAttachmentController';
import { restoreWaitingAttachment } from './pending-interaction';

const ACTIVE_TASK_KEY = 'ui.privileged.active-task';

export async function rememberTaskAttachment(control: EditorTaskControlPlane, sessionId: string,
    attachment: RunAttachmentController, taskId: string): Promise<void> {
    const session = await control.openSession(sessionId);
    await session.setShared(ACTIVE_TASK_KEY, { taskId });
    await attachment.attach(taskId);
}

/** Async restoration checks editor identity before every visible effect. */
export async function restoreTaskAttachment(control: EditorTaskControlPlane, sessionId: string,
    attachment: RunAttachmentController, isCurrent: () => boolean,
    excludedTasks: () => Promise<ReadonlySet<string>>): Promise<void> {
    const session = await control.openSession(sessionId);
    if (!isCurrent()) return;
    const entry = await session.getShared(ACTIVE_TASK_KEY);
    if (!isCurrent()) return;
    const taskId = sharedTaskId(entry?.value);
    if (taskId) {
        const task = (await (await session.attachTask(taskId)).status()).task;
        if (!isCurrent()) return;
        if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) {
            if (attachment.activeTaskId !== taskId) await attachment.attach(taskId);
            return;
        }
    }
    await restoreWaitingAttachment(control, sessionId, id => attachment.attach(id), isCurrent, await excludedTasks());
}

function sharedTaskId(value: JsonValue | undefined): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return typeof value.taskId === 'string' ? value.taskId : undefined;
}

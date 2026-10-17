import type { JsonValue } from '@itookit/durable-kernel/contracts';
import type { EditorTaskControlPlane, ReadTaskAttachment, TaskRecord } from '@itookit/durable-kernel/contracts';
import type { RunAttachmentController } from './RunAttachmentController';
import { pendingInteractionTask, restoreWaitingAttachment } from './pending-interaction';

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
    excludedTasks: () => Promise<ReadonlySet<string>>, readRecovery?: ReadTaskAttachment): Promise<void> {
    if (readRecovery) return restoreAggregated(control, readRecovery, sessionId, attachment, isCurrent, excludedTasks);
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

async function restoreAggregated(control: EditorTaskControlPlane, read: ReadTaskAttachment,
    sessionId: string, attachment: RunAttachmentController,
    isCurrent: () => boolean, excludedTasks: () => Promise<ReadonlySet<string>>): Promise<void> {
    const state = await read(sessionId, ACTIVE_TASK_KEY);
    if (!isCurrent()) return;
    if (state.activeTaskId) {
        const task = await currentTask(control, state.activeTaskId, sessionId, isCurrent);
        if (!isCurrent()) return;
        if (task && !['succeeded', 'failed', 'cancelled'].includes(task.status)) {
            if (attachment.activeTaskId !== task.id) await attachment.attach(task.id);
            return;
        }
    }
    if (state.pendingTaskIds.length) {
        await restorePendingCandidates(control, sessionId, state.pendingTaskIds, attachment, isCurrent, excludedTasks);
    }
}

async function restorePendingCandidates(control: EditorTaskControlPlane, sessionId: string,
    taskIds: readonly string[], attachment: RunAttachmentController, isCurrent: () => boolean,
    excludedTasks: () => Promise<ReadonlySet<string>>): Promise<void> {
    const excluded = await excludedTasks();
    if (!isCurrent()) return;
    for (const taskId of taskIds) {
        if (excluded.has(taskId)) continue;
        const task = await currentTask(control, taskId, sessionId, isCurrent);
        if (!isCurrent()) return;
        if (!task || !pendingInteractionTask([task])) continue;
        await attachment.attach(taskId);
        return;
    }
}

async function currentTask(control: EditorTaskControlPlane, taskId: string, sessionId: string,
    isCurrent: () => boolean): Promise<TaskRecord | undefined> {
    const handle = await control.openTask(taskId);
    if (!isCurrent()) return;
    const {task} = await handle.status();
    if (isCurrent() && task.sessionId === sessionId) return task;
}

function sharedTaskId(value: JsonValue | undefined): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return typeof value.taskId === 'string' ? value.taskId : undefined;
}

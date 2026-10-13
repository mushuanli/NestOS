import type { TaskRecord } from '@itookit/durable-kernel';
import type { PendingInteractionTaskSource } from '@itookit/durable-kernel';

const TERMINAL = ['succeeded', 'failed', 'cancelled'];

/**
 * The run a previous host left waiting for an approval, if any.
 *
 * A Task that is still non-terminal with a pending interaction is exactly the durable state a
 * crash leaves behind: nothing re-drives it on reopen, so the host must re-attach to it or the
 * prompt never reappears and the Session cannot continue.
 */
export function pendingInteractionTask(tasks: readonly TaskRecord[]): TaskRecord | undefined {
    return tasks
        .filter(task => !TERMINAL.includes(task.status))
        .filter(task => Object.values(task.interactions ?? {}).some(interaction => interaction.status === 'pending'))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

/** Re-attach a waiting run; returns the attached Task id when there was one. */
export async function restoreWaitingAttachment(
    kernel: PendingInteractionTaskSource,
    sessionId: string,
    attach: (taskId: string) => Promise<void>,
    isCurrent: () => boolean = () => true,
    excluded: ReadonlySet<string> = new Set(),
): Promise<string | undefined> {
    if (!isCurrent()) return undefined;
    const tasks = kernel.listSessionPendingInteractionTasks
        ? await kernel.listSessionPendingInteractionTasks(sessionId)
        : await kernel.listSessionTasks(sessionId);
    const waiting = pendingInteractionTask(tasks.filter(task => !excluded.has(task.id)));
    if (!waiting || !isCurrent()) return undefined;
    await attach(waiting.id);
    return waiting.id;
}

import { FSError } from '@itookit/vfs-core';
import { KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import type { TaskAttachmentRecovery, TaskRecord, JsonValue } from '@itookit/durable-kernel/contracts';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';

const terminal = new Set(['succeeded', 'failed', 'cancelled']);

/** Aggregate recovery reads for one explicit Session without changing the browser binding. */
export async function taskAttachment(services: LocalApplicationServices, sessionId: string, sharedKey: string): Promise<TaskAttachmentRecovery> {
    if (typeof sharedKey !== 'string' || !sharedKey || sharedKey.length > 200) throw new FSError('EINVAL', 'Invalid shared key');
    await services.sessionRepository.getManifest(sessionId);
    const kernel = services.kernel.kernel, session = await inspectExistingSession(kernel, sessionId);
    if (!session) return {pendingTaskIds: []};
    const [entry, pending] = await Promise.all([
        session.getShared(sharedKey), session.listPendingInteractionTasks(),
    ]);
    const id = sharedTaskId(entry?.value);
    const active = id ? await kernel.task(sessionId, id) : undefined;
    return { activeTaskId: active && !terminal.has(active.status) ? active.id : undefined,
        pendingTaskIds: pending.filter(hasPendingInteraction).sort((a, b) => b.updatedAt - a.updatedAt).map(task => task.id) };
}

async function inspectExistingSession(kernel: LocalApplicationServices['kernel']['kernel'], sessionId: string) {
    try { return await kernel.inspectSession(sessionId); }
    catch (error) {
        if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return undefined;
        throw error;
    }
}

function sharedTaskId(value: JsonValue | undefined): string | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.taskId === 'string' ? value.taskId : undefined;
}
function hasPendingInteraction(task: TaskRecord): boolean {
    return !terminal.has(task.status) && Object.values(task.interactions ?? {}).some(item => item.status === 'pending');
}

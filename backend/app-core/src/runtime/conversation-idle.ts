import { taskStat, KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import type { KernelViewPort } from '@itookit/durable-kernel/contracts';

/** Terminal scheduler state alone does not prove external effects have stopped. */
export async function conversationIdle(kernel: Pick<KernelViewPort, 'listSessionTasks'>, sessionId: string): Promise<boolean> {
    try {
        const tasks = await kernel.listSessionTasks(sessionId);
        return tasks.every(task => {
            if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) return false;
            const stat = taskStat(task);
            return stat.activeOperations === 0 && stat.control.acknowledged;
        });
    } catch (error) { if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return true; throw error; }
}

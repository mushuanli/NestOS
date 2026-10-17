import { taskStat, KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import { taskKeyEvent, taskSummary } from '../session/session-browser';
import type { ApplicationKernelPort, TaskEventQuery, TaskEventView, TaskDetail, SessionTaskQuery, SessionTaskPage } from '@itookit/app-contracts/services';

export async function sessionTasks(kernel: ApplicationKernelPort, sessionId: string, options?: SessionTaskQuery): Promise<SessionTaskPage> {
    try {
        const page = await kernel.listSessionTaskPage(sessionId, options);
        return { ...page, items: page.items.map(task => ({ id: task.id, program: task.program, status: task.status })) };
    } catch (error) {
        if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return { items: [], throughIndex: 0 };
        throw error;
    }
}

export async function taskEvents(kernel: ApplicationKernelPort, sessionId: string, taskId: string, options?: TaskEventQuery): Promise<TaskEventView> {
    const page = await kernel.taskEventPage(sessionId, taskId, options);
    return { ...page, items: page.items.filter(event => event.taskId === taskId).map(taskKeyEvent).filter(event => event !== undefined) };
}
export async function taskDetails(kernel: ApplicationKernelPort, sessionId: string, taskId: string): Promise<TaskDetail> {
    const [task, events] = await Promise.all([kernel.task(sessionId, taskId), taskEvents(kernel, sessionId, taskId)]);
    return { task: { id: task.id, program: task.program, status: task.status }, stat: taskStat(task), summary: taskSummary(task), events };
}

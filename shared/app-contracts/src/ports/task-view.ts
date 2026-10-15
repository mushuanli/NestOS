import type { TaskRecord, TaskStat, KernelViewPort } from '@itookit/durable-kernel/contracts';
import type { taskKeyEvent, taskSummary } from './session';

export type TaskEventQuery = Parameters<KernelViewPort['taskEventPage']>[2];
export type TaskEventView = Omit<Awaited<ReturnType<KernelViewPort['taskEventPage']>>, 'items'> & {
    items: Array<NonNullable<ReturnType<typeof taskKeyEvent>>>;
};
export interface TaskDetail {
    task: Pick<TaskRecord, 'id' | 'program' | 'status'>;
    stat: TaskStat;
    summary: ReturnType<typeof taskSummary>;
    events: TaskEventView;
}

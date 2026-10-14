import type {
    LeaseGuardOptions, SessionHandle, SessionRecord, StorageBindingRef, TaskHandle,
    TaskRecord, TaskListQuery, TaskListPage, TaskEventQuery, TaskEventPage,
} from '../domain/types';
import type { SessionStat } from '../domain/status';

export type KernelChangeReason = 'structure' | 'content';

/** Capabilities required by local application views; worker ownership stays with the host. */
export interface KernelViewPort {
    openSession(id: string, expectedStorage?: StorageBindingRef): Promise<SessionHandle>;
    openTask<O = unknown>(id: string): Promise<TaskHandle<O>>;
    listSessionTasks(sessionId: string): Promise<TaskRecord[]>;
    listSessionPendingInteractionTasks(sessionId: string): Promise<TaskRecord[]>;
    listSessions(): AsyncIterable<SessionRecord>;
    task(sessionId: string, taskId: string): Promise<TaskRecord>;
    listSessionTaskPage(sessionId: string, query?: TaskListQuery): Promise<TaskListPage>;
    taskEventPage(sessionId: string, taskId: string, query?: TaskEventQuery): Promise<TaskEventPage>;
    cancel(sessionId: string, taskId: string, reason?: string, options?: LeaseGuardOptions): Promise<void>;
    closeSession(sessionId: string, cancelRunning: boolean): Promise<void>;
    removeSession(sessionId: string, options?: { force?: boolean }): Promise<boolean>;
    sessionStat(sessionId: string): Promise<SessionStat>;
    onChanged(listener: (event: { sessionId: string; taskId?: string; reason: KernelChangeReason }) => void): () => void;
}

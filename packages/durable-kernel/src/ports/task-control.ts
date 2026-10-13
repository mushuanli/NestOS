import type { SessionHandle, TaskHandle, TaskRecord } from '../domain/types';

export type AttachedTask = Pick<TaskHandle, 'id' | 'events' | 'signal' | 'start' | 'cancel' | 'status' | 'respond' | 'pause' | 'interrupt' | 'resume'>;

export interface TaskControlPlane {
    openTask(id: string): Promise<AttachedTask>;
}

export interface PendingInteractionTaskSource {
    listSessionTasks(sessionId: string): Promise<TaskRecord[]>;
    listSessionPendingInteractionTasks?(sessionId: string): Promise<TaskRecord[]>;
}

/** Only shared attachment identity and task status are needed by an editor. */
export interface TaskAttachmentSession extends Pick<SessionHandle, 'getShared' | 'setShared'> {
    attachTask(id: string): Promise<Pick<AttachedTask, 'status'>>;
}

/** Structural host port; a Kernel or a remote client can implement it. */
export interface EditorTaskControlPlane extends TaskControlPlane, PendingInteractionTaskSource {
    openSession(sessionId: string): Promise<TaskAttachmentSession>;
}

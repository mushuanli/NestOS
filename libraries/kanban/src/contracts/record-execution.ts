import type {KanbanExternalReference} from './configuration';

/** Hosts resolve opaque resources and execute records; the library owns no project policy. */
export interface KanbanRecordResource {reference: KanbanExternalReference; label: string}
export interface KanbanRecordExecution {
    id: string; recordId: string; recordRevision: number; boardId: string;
    state: 'preparing' | 'running' | 'blocked' | 'review' | 'completed' | 'failed';
    createdAt: number; updatedAt: number; code?: string;
}
export interface KanbanRecordRunRequest {operationId: string; recordId: string; expectedRevision: number}

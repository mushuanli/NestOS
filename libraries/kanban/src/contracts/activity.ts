import type {KanbanService} from './contracts';
import type {KanbanItemPage, KanbanItemQuery, KanbanItemSummary} from './planning';
export type KanbanSessionPhase = 'running' | 'queued' | 'waiting' | 'waiting-input' | 'waiting-approval' | 'paused' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface KanbanExecutionSession {
    sessionId: string; resourceId?:string; title?: string; state: KanbanSessionPhase;
    lastActivityAt?: number; observedAt?: number; stale: boolean; recent: boolean; code?: string;
}
export interface KanbanSessionActivityQuery extends KanbanItemQuery {execution?: 'all' | 'running' | 'recent' | 'active'}
export interface KanbanSessionItemSummary extends KanbanItemSummary {execution?: KanbanExecutionSession}
export interface KanbanSessionItemPage extends Omit<KanbanItemPage,'items'> {items: KanbanSessionItemSummary[]}
export interface KanbanExecutionSessionDetail {
    current?: KanbanExecutionSession;
    history: Array<{sessionId: string; bindingId?: string; current: boolean}>;
}

/** Transport-facing service with optional authorized resource activity. */
export interface KanbanClient extends KanbanService {
    workResources?(boardId: string, itemId: string): Promise<import('./work-resources').KanbanWorkResource[]>;
    cleanupWorkResource?(boardId: string, request: import('./work-resources').KanbanWorkResourceCleanup): Promise<import('./work-resources').KanbanWorkResource>;
    itemResources?(boardId:string,parentId?:string):Promise<import('./record-execution').KanbanItemResourceCatalog>;
    recordResources?(): Promise<import('./record-execution').KanbanRecordResource[]>;
    runRecord?(boardId: string, request: import('./record-execution').KanbanRecordRunRequest): Promise<import('./record-execution').KanbanRecordExecution>;
    recordExecutions?(boardId: string, recordId: string): Promise<import('./record-execution').KanbanRecordExecution[]>;
    automationCatalog?(): Promise<import('./automation').KanbanAutomationCatalog>;
    analysisStatus?(boardId: string, itemId: string): Promise<import('./automation').KanbanAnalysisStatus | null>;
    queryActivity?(boardId: string, query?: KanbanSessionActivityQuery): Promise<KanbanSessionItemPage>;
    executionSession?(boardId: string, itemId: string): Promise<KanbanExecutionSessionDetail>;
}

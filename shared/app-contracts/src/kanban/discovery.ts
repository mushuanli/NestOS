import type {KanbanItemSummary, KanbanPlanning} from './planning';
import type {KanbanBoard} from './contracts';

export interface KanbanSourceRef {sessionId: string; messageId: string; revision: string; role: 'user' | 'assistant'}
export interface KanbanScanSession {
    id: string; revision: string; updatedAt: number | null; idleSince: number | null;
    activity: 'idle' | 'active' | 'waiting' | 'unknown'; archived: boolean; scannerOwned?: boolean;
}
export interface KanbanScanText {
    session: KanbanScanSession; complete: boolean;
    messages: Array<{id: string; role: 'user' | 'assistant'; text: string}>;
}
export interface KanbanDiscoveryChange {
    action: 'create' | 'update' | 'link'; itemId: string; title: string; responsibility: string; acceptance: string;
    eligibleAgentIds?: string[]; eligiblePrincipals?: import('./configuration').KanbanPrincipal[]; sources: KanbanSourceRef[]; planning?: KanbanPlanning;
}
export interface KanbanDiscoveryBatch {
    records?: import('./context').KanbanRecordInput[];
    runId: string; leaseToken: string; changes: KanbanDiscoveryChange[]; checkpoints: Array<{sessionId: string; revision: string}>;
    autoCreate: boolean;
}
export interface KanbanScanConnection {
    kind: 'local' | 'remote'; connectionId: string;
    /** Explicit consent for moving source text to a different execution boundary. */
    allowContentTransfer: boolean;
}
export interface KanbanScanPolicy {
    idleMs: number; includeArchived: boolean; maxSessions: number; maxInputBytes: number; leaseMs: number;
    autoCreate: boolean; connection: KanbanScanConnection;
}
export interface KanbanScanInput {
    projectContext?: {totalRecords: number; excludedRecords?: number; omittedRecords: number; records: import('./context').KanbanProjectRecord[]};
    context?: {totalItems: number; omittedItems: number; archivedTotal: number; archivedItems: KanbanItemSummary[]};
    runId: string; executorId: string; board: KanbanBoard; sessions: KanbanScanText[]; connection: KanbanScanConnection;
}
export const DEFAULT_KANBAN_SCAN_POLICY: Omit<KanbanScanPolicy, 'connection'> = {
    idleMs: 300000, includeArchived: true, maxSessions: 20, maxInputBytes: 128 * 1024, leaseMs: 600000, autoCreate: false,
};

export interface KanbanDiscoveryResult {changes: KanbanDiscoveryChange[]; records?: import('./context').KanbanRecordInput[]}

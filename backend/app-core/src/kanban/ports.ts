import type { KanbanActor, KanbanBoard, KanbanCommand, KanbanEvent, KanbanArchivedItem, KanbanItemSummary } from '@itookit/app-contracts';

export interface KanbanState {
    numbering?: {item: number; log: number; decision: number};
    presetVersions?: Record<string, number>;
    records?: import('@itookit/app-contracts').KanbanProjectRecord[];
    discovery?: import('./scan-ports').KanbanDiscoveryState;
    archiveIndex?: KanbanItemSummary[];
    archiveWrites?: Array<{id: string; value: KanbanArchivedItem | null}>;
    restore?: KanbanArchivedItem;
    schema: 1; board: KanbanBoard; sequence: number; events: KanbanEvent[]; escalations: string[];
}
export interface KanbanReadView {
    /** Board metadata and summary indexes; no item/record bodies. */
    state: KanbanState;
    items: import('@itookit/app-contracts').KanbanItemSummary[];
    records: import('@itookit/app-contracts').KanbanRecordSummary[];
}
export interface KanbanStore {
    boardId?(number: number): Promise<string | null>;
    view?(id: string): Promise<KanbanReadView | null>;
    ids(): Promise<string[]>;
    archived(boardId: string, itemId: string): Promise<KanbanArchivedItem | null>;
    events(id: string, after: number, limit: number, through: number): Promise<KanbanEvent[]>;
    read(id: string): Promise<KanbanState | null>;
    update(id: string, operationId: string, fingerprint: string,
        change: (state: KanbanState | null) => KanbanState): Promise<KanbanState>;
}
export interface KanbanModuleOptions {
    /** Host supplies metadata within the authorized user's/project's session scope. */
    sessionSuggestions?(board: KanbanBoard, search: string, limit: number): Promise<import('@itookit/app-contracts').KanbanSuggestion[]>;
    notifications?: import('./notifications').KanbanNotifications;
    store: KanbanStore;
    /** Trusted identity resolved by the host, never from command payloads. */
    actor: KanbanActor;
    /** Must validate project access, delegated authority and session registration. */
    authorize(input: { actor: KanbanActor; board: KanbanBoard; action: 'create' | 'read' | KanbanCommand['type']; command?: KanbanCommand }): Promise<void>;
    /** Confirm an automated owner has settled before releasing responsibility. */
    verifyRelease?(input: {actor: KanbanActor; board: KanbanBoard; item: import('@itookit/app-contracts').KanbanItem}): Promise<boolean>;
    now?: () => number;
    id?: () => string;
    log(event: { operationId: string; boardId?: string; sessionId?: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number }): void;
}
export class KanbanError extends Error {
    constructor(readonly code: string) { super(code); this.name = 'KanbanError'; }
}

/** Trusted executor evidence that no model invocation was submitted. */
export class KanbanScanNotStartedError extends KanbanError {}

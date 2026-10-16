/** Presentation port; hosts own execution, identity and authorization. */
export interface ConversationMessage {
    id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: string;
    /** Native text array boundaries, kept separate from the plain-text preview. */
    contentParts?: string[];
    turnId?: string; name?: string; input?: string; inputLanguage?: 'bash' | 'json' | 'text';
    timestamp?: number; paths?: string[]; operation?: 'read' | 'write' | 'search' | 'list' | 'execute'; commandPreview?: string;
}
export interface ConversationRequest { id: string | number; kind: 'approval' | 'input' | 'unsupported'; detail: string; questions?: Array<{id: string; question: string; options?: Array<{label: string}>}> }
export interface ConversationAttachment {kind: 'text' | 'image'; name: string; content: string; mimeType?: string}
export interface ConversationSnapshot {
    /** Native turn identity acknowledged for the most recent send on this view. */
    submittedTurnId?: string;
    draftAttachments?: ConversationAttachment[];
    attachments?: Array<'text' | 'image'>;
    archived?: boolean; canRename?: boolean; canArchive?: boolean; canUnarchive?: boolean;
    observation?: {
        rawStatus?: string | null;
        updatedAt?: number | null;
        execution: 'unknown' | 'idle' | 'running' | 'waiting-approval' | 'waiting-input';
        lastResult?: 'completed' | 'failed' | 'cancelled';
        nativeError?: boolean;
        canInterrupt?: boolean; canRespond?: boolean;
        source: 'list' | 'inspect' | 'history' | 'events'; observedAt: number; connection: 'online' | 'offline'; stale: boolean; receiptUnknown: boolean;
    };
    active?: boolean; createdAt?: number | null; updatedAt?: number | null;
    canFork?: boolean; hasEarlier?: boolean;
    draft?: string; sessionId?: string; branchName?: string; title: string; messages: ConversationMessage[]; requests: ConversationRequest[];
    canSend: boolean; canInterrupt: boolean; canRespond: boolean; pending: boolean; disconnected: boolean; gap: boolean;
}
export interface ConversationControls {
    subscribe?(listener: () => void): () => void;
    rename?(name: string): Promise<ConversationSnapshot>;
    archive?(archived: boolean): Promise<ConversationSnapshot>;
    /** Local observation of receipts and control ownership, including while offline. */
    snapshot?(): ConversationSnapshot;
    fork?(name?: string): Promise<ConversationSnapshot>;
    branches?(): Promise<Array<{id:string; title:string; branchName?:string | null; parentSessionId?:string | null}>>;
    loadEarlier?(): Promise<ConversationSnapshot>;
    saveDraft?(text: string, attachments?: ConversationAttachment[]): Promise<void>;
    read(): Promise<ConversationSnapshot>;
    poll(): Promise<ConversationSnapshot>;
    send(text: string, attachments?: Array<{kind: 'text' | 'image'; name: string; content: string; mimeType?: string}>): Promise<ConversationSnapshot>;
    interrupt(): Promise<ConversationSnapshot>;
    respond(id: string | number, response: Record<string, unknown>): Promise<ConversationSnapshot>;
    reconcile(): Promise<ConversationSnapshot>;
    close(): Promise<void>;
}
export interface RemoteAgentControls {
    list(): Promise<Array<{id: string; name: string; icon: string; category: string; description?: string}>>;
    send(id: string, text: string): Promise<void>;
}

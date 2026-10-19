/** Presentation port; hosts own execution, identity and authorization. */
export interface ConversationMessage {
    id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: string;
    /** Native text array boundaries, kept separate from the plain-text preview. */
    contentParts?: string[];
    /** Native provenance aligned with contentParts; absent or unknown means ordinary prompt text. */
    contentPartKinds?: string[];
    turnId?: string; name?: string; input?: string; inputLanguage?: 'bash' | 'json' | 'text';
    timestamp?: number; paths?: string[]; operation?: 'read' | 'write' | 'search' | 'list' | 'execute'; commandPreview?: string;
}
export interface ConversationRequest {
    id: string | number; kind: 'approval' | 'input' | 'unsupported'; detail: string; title?: string;
    decisions?: string[]; responding?: boolean;
    questions?: Array<{id: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; isOther?: boolean;
        options?: Array<{label: string; description?: string}>}>;
}
export interface ConversationAttachment {kind: 'text' | 'image'; name: string; content: string; mimeType?: string}
export interface ConversationSlashCommand {name: string; description: string; argumentHint?: string; kind: 'prompt' | 'action'; disabled?: boolean}
export interface ConversationModelSelection {modelId: string; reasoningEffort?: string}
export interface ConversationModelCatalog {
    models: Array<{id: string; label: string; reasoningEfforts: Array<{id: string; label: string}>; defaultReasoningEffort?: string}>;
    current?: ConversationModelSelection; default?: ConversationModelSelection;
}
export interface ConversationSnapshot {
    supportsModels?: boolean;
    supportsSlashCommands?: boolean;
    slashCommands?: ConversationSlashCommand[];
    usage?: {scope: 'transcript'; complete: boolean; observedAt: number;
        totals: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number}};
    usageUnavailable?: boolean;
    usageEstimate?: {currency: 'USD'; estimatedCostUsd: number | null; complete: boolean};
    /** Native turn identity acknowledged for the most recent send on this view. */
    submittedTurnId?: string;
    submission?: {id: string; status: 'pending' | 'accepted' | 'rejected'; turnId?: string};
    draftAttachments?: ConversationAttachment[];
    attachments?: Array<'text' | 'image'>;
    archived?: boolean; canRename?: boolean; canArchive?: boolean; canUnarchive?: boolean;
    observation?: {
        rawStatus?: string | null;
        updatedAt?: number | null;
        execution: 'unknown' | 'idle' | 'running' | 'waiting-approval' | 'waiting-input';
        lastResult?: 'completed' | 'failed' | 'cancelled';
        nativeError?: boolean;
        refreshError?: {stage: string; code: string};
        canInterrupt?: boolean; canRespond?: boolean;
        source: 'list' | 'inspect' | 'history' | 'events'; observedAt: number; connection: 'online' | 'offline'; stale: boolean; receiptUnknown: boolean;
    };
    active?: boolean; createdAt?: number | null; updatedAt?: number | null;
    canFork?: boolean; hasEarlier?: boolean;
    draft?: string; sessionId?: string; branchName?: string; title: string; messages: ConversationMessage[]; requests: ConversationRequest[];
    canSend: boolean; canInterrupt: boolean; canRespond: boolean; pending: boolean; disconnected: boolean; gap: boolean;
}
export interface ConversationComposerDraft {revision: string; data: string; acceptedOperationIds: readonly string[]}
export interface ConversationControls {
    readComposerDraft?(): Promise<ConversationComposerDraft>;
    saveComposerDraft?(data: string, expectedRevision: string, operationId: string): Promise<ConversationComposerDraft>;
    putComposerAsset?(content: ArrayBuffer): Promise<string>;
    readComposerAsset?(id: string): Promise<ArrayBuffer>;
    models?(): Promise<ConversationModelCatalog>;
    commands?(): Promise<ConversationSlashCommand[]>;
    command?(name: string, args?: string, selection?: ConversationModelSelection, inputText?: string, submissionId?: string): Promise<ConversationSnapshot>;
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
    send(text: string, attachments?: Array<{kind: 'text' | 'image'; name: string; content: string; mimeType?: string}>, selection?: ConversationModelSelection, submissionId?: string): Promise<ConversationSnapshot>;
    interrupt(): Promise<ConversationSnapshot>;
    respond(id: string | number, response: Record<string, unknown>): Promise<ConversationSnapshot>;
    reconcile(submissionId?: string): Promise<ConversationSnapshot>;
    close(): Promise<void>;
}
export interface RemoteAgentControls {
    models?(id: string): Promise<ConversationModelCatalog>;
    list(): Promise<Array<{id: string; name: string; icon: string; category: string; description?: string; supportsModels?: boolean; attachmentKinds?: Array<'text' | 'image'>}>>;
    send(id: string, text: string, selection?: ConversationModelSelection, files?: File[]): Promise<void>;
}

import type {InteractionEditorDraft} from '@itookit/llm-ui';
/** Editing state only; an interaction draft is never an answer admission. */
export interface InteractionDraftScope {
    sessionId: string; branchId: string; callId: string; executionSessionId: string;
    taskId: string; targetTaskId: string; interactionId: string; requestedAt: number;
}
export interface InteractionDraftContent {
    format: 'text' | 'json';
    values: Record<string, string | string[]>;
    note?: string;
    editor?: InteractionEditorDraft;
}
export interface InteractionDraftRecord {
    revision: number;
    editId: string;
    /** Null is a retained clear, not an absent baseline. */
    content: InteractionDraftContent | null;
}
export interface InteractionDraftWrite {
    scope: InteractionDraftScope;
    expectedRevision: number | null;
    editId: string;
    content: InteractionDraftContent | null;
}
export interface InteractionDraftStorage {
    read(scope: InteractionDraftScope): Promise<InteractionDraftRecord | undefined>;
    write(change: InteractionDraftWrite): Promise<InteractionDraftRecord>;
}

import type { ChatMessage } from './message';
import type { ContextCompactionPolicy } from './policy';

export interface ContentRef { id: string; sha256: string; bytes: number; mediaType: string }
export interface ContextCursor { contextId: string; revision: number; generation: number; snapshot: ContentRef }
export interface ContextHistorySegment {
    id: string;
    previous: ContentRef | null;
    messages: ChatMessage[];
}
export interface WorkingNotes {
    revision: number;
    basedOnRevision: number;
    text: string;
    evidence: ContentRef[];
}
export interface ContextRequestSnapshot {
    schema: 1;
    contextId: string;
    revision: number;
    generation: number;
    history: ContentRef;
    notes: WorkingNotes | null;
    request: Record<string, unknown> & { messages: ChatMessage[] };
    digest: string;
    explanation: WindowExplanation;
}
export interface WindowExplanation {
    strategy: 'retain' | 'prune' | 'summary-tail' | 'checkpoint-reset';
    inputTokens: number;
    estimated: boolean;
    removedMessages: number;
}
export interface ContextPrepareInput {
    contextId: string;
    operationId: string;
    previous?: ContextCursor;
    messages: ChatMessage[];
    request: Record<string, unknown>;
    policy?: ContextCompactionPolicy;
    notes?: WorkingNotes;
    archiveOnly?: boolean;
}
export interface ContextRecordWrite { key: string; value: unknown; expectedVersion: number | null }
export interface PreparedContext {
    cursor: ContextCursor;
    writes: ContextRecordWrite[];
    explanation: WindowExplanation;
}
export interface IContextContentStore {
    publish(content: string, mediaType?: string): Promise<ContentRef>;
    read(ref: ContentRef): Promise<string>;
}
export interface IContextRecordReader {
    get(key: string): Promise<unknown | undefined>;
}
export interface ContextHistoryPage {
    items: Array<{ id: string; index: number; message: ChatMessage }>;
    next: { segment: ContentRef; offset: number } | null;
}
export interface IContextReader {
    inspect(contextId: string): Promise<ContextRequestSnapshot | null>;
    history(contextId: string, options?: { cursor?: { segment: ContentRef; offset: number }; limit?: number; maxBytes?: number; query?: string }): Promise<ContextHistoryPage>;
    read(ref: ContentRef, offset?: number, limit?: number): Promise<{ text: string; nextOffset: number | null }>;
}
export interface IContextService extends IContextReader {
    prepare(input: ContextPrepareInput): Promise<PreparedContext>;
    request(cursor: ContextCursor): Promise<ContextRequestSnapshot>;
    admitOutput(output: string, maxBytes?: number): Promise<{ output: string; contentRef?: ContentRef }>;
}
export interface ContextBudget {
    inputTokens: number;
    maxInputTokens: number;
    estimated: boolean;
}
export interface ContextEngineOptions {
    defaultPolicy?: ContextCompactionPolicy;
    /** Count the complete provider request, including envelopes and tool schemas. */
    estimateTokens?: (request: Record<string, unknown>) => number;
    /** False only when the injected counter is exact for the selected provider. */
    estimated?: boolean;
}
export interface IContextEngine {
    measure?(request: Record<string, unknown>, policy?: ContextCompactionPolicy): ContextBudget;
    select(messages: ChatMessage[], request: Record<string, unknown>, policy?: ContextCompactionPolicy): WindowSelection;
}
export interface WindowSelection {
    messages: ChatMessage[];
    removed: ChatMessage[];
    explanation: WindowExplanation;
}
export interface ContextServicePorts {
    content: IContextContentStore;
    records: IContextRecordReader;
    engine?: IContextEngine;
    engineOptions?: ContextEngineOptions;
    summarize?: (messages: ChatMessage[], maxTokens: number) => Promise<string>;
}

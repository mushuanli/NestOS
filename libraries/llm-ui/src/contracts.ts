import type { AssetProvider } from '@itookit/mdxeditor';
import type { FlowOptions } from './flow-contracts';

export type JsonValue = null | boolean | number | string | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };
export type ActionName = 'send' | 'cancel' | 'retry' | 'edit' | 'respond';
export type OperationKind = ActionName | 'flow.add-node' | 'flow.update-node' | 'flow.remove-node'
    | 'flow.connect' | 'flow.disconnect' | 'flow.save' | 'flow.run' | 'flow.cancel';
export interface AttachmentRef { readonly id: string; readonly name: string; readonly mimeType?: string }
export interface DraftAttachment { readonly id: string; readonly file: AttachmentRef }
export interface MessageTarget { readonly messageId: string; readonly expectedRevision: number }
export type MessagePart =
    | { readonly id: string; readonly kind: 'markdown' | 'reasoning'; readonly text: string }
    | { readonly id: string; readonly kind: 'tool'; readonly name: string; readonly summary: string;
        readonly state: 'running' | 'succeeded' | 'failed'; readonly detail?: string }
    | { readonly id: string; readonly kind: 'attachment'; readonly file: AttachmentRef }
    | { readonly id: string; readonly kind: 'extension'; readonly type: string; readonly data: JsonValue };
export interface ChatMessage {
    readonly id: string;
    readonly revision: number;
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly parts: readonly MessagePart[];
    readonly state: 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled';
    readonly submissionId?: string;
    /** Only confirmed user messages are evidence of submission acceptance. */
    readonly acceptance?: 'optimistic' | 'confirmed';
    readonly allowed?: readonly ('edit' | 'retry')[];
    readonly timestamp?: number;
}
export interface Choice { readonly id: string; readonly label: string }
export type InputField = { readonly id: string; readonly label: string; readonly required?: boolean } & (
    | { readonly kind: 'text'; readonly multiline?: boolean }
    | { readonly kind: 'single-choice'; readonly choices: readonly Choice[] }
    | { readonly kind: 'multi-choice'; readonly choices: readonly Choice[]; readonly min?: number; readonly max?: number }
);
export type InteractionView = {
    readonly id: string; readonly revision: number; readonly title: string; readonly detail?: string;
    readonly state: 'pending' | 'resolved' | 'cancelled' | 'expired';
    readonly messageId?: string; readonly partId?: string;
} & (
    | { readonly kind: 'approval'; readonly decisions: readonly Choice[]; readonly note?: boolean }
    | { readonly kind: 'input'; readonly fields: readonly InputField[] }
);
export type InteractionResponse =
    | { readonly kind: 'approval'; readonly decisionId: string; readonly note?: string }
    | { readonly kind: 'input'; readonly values: Readonly<Record<string, string | readonly string[]>> };
export interface SelectorView { readonly id: string; readonly label: string; readonly value: string;
    readonly choices: readonly Choice[]; readonly disabled?: boolean }
export interface ConversationSnapshot {
    /** Stable across observation bindings; it is not an authorization token. */
    readonly conversationId: string;
    readonly viewId: string;
    readonly revision: number;
    readonly title: string;
    readonly messages: readonly ChatMessage[];
    readonly interactions: readonly InteractionView[];
    readonly selectors?: readonly SelectorView[];
    readonly loading: boolean;
    readonly execution: 'unknown' | 'idle' | 'running' | 'waiting-input';
    readonly executionRef?: string;
    readonly connection: 'online' | 'offline' | 'reconnecting';
    readonly hasEarlier: boolean;
    readonly allowed: readonly ActionName[];
    readonly error?: { readonly code: string; readonly message: string };
}
export interface ConversationSource {
    getSnapshot(): ConversationSnapshot;
    subscribe(listener: () => void): () => void;
    refresh?(): Promise<void>;
}
export interface OperationContext { readonly viewId: string; readonly operationId: string }
export type OperationReceipt =
    | { readonly status: 'accepted'; readonly operationId: string; readonly submissionRef?: string;
        readonly observedUserMessageId?: string }
    | { readonly status: 'rejected'; readonly operationId: string; readonly code: string; readonly message: string }
    | { readonly status: 'unknown'; readonly operationId: string; readonly message: string };
export interface ChatSubmission { readonly text: string; readonly attachments: readonly AttachmentRef[];
    readonly selection?: Readonly<Record<string, string>> }
export interface ConversationActions {
    send?(input: ChatSubmission, context: OperationContext): Promise<OperationReceipt>;
    cancel?(executionRef: string, context: OperationContext): Promise<OperationReceipt>;
    /** Regenerate a reply from this message; never retry an uncertain send. */
    retry?(target: MessageTarget, context: OperationContext): Promise<OperationReceipt>;
    /** Host determines branching and installs a new observation binding when necessary. */
    edit?(target: MessageTarget, text: string, context: OperationContext): Promise<OperationReceipt>;
    respond?(request: { readonly id: string; readonly revision: number; readonly response: InteractionResponse },
        context: OperationContext): Promise<OperationReceipt>;
    loadEarlier?(options: { readonly signal: AbortSignal }): Promise<void>;
    /** Query by stable identity, even after the original viewId has expired. */
    reconcile?(operationId: string): Promise<OperationReceipt>;
}
export interface ComposerDraft {
    readonly revision: number;
    readonly textRevision: number;
    readonly text: string;
    readonly attachments: readonly DraftAttachment[];
}
export interface OperationRecord {
    readonly context: OperationContext;
    readonly conversationId: string;
    readonly kind: OperationKind;
    readonly input: JsonValue;
    readonly draft?: ComposerDraft;
    readonly status: 'submitting' | OperationReceipt['status'];
    readonly message?: string;
    readonly submissionRef?: string;
    /** A confirmed user message has actually appeared, not merely been allocated an ID. */
    readonly observedUserMessageId?: string;
}
/** Hosts retain this ledger beyond any ChatView and persist it when recovery is required. */
export interface OperationLedger {
    getSnapshot(): readonly OperationRecord[];
    subscribe(listener: () => void): () => void;
    register(record: OperationRecord): Promise<void>;
    settle(receipt: OperationReceipt): Promise<void>;
}
export interface RenderContext { readonly message: ChatMessage; readonly snapshot: ConversationSnapshot }
export interface MountedRenderer {
    update?(part: Extract<MessagePart, { kind: 'extension' }>, context: RenderContext): void | Promise<void>;
    destroy(): void | Promise<void>;
}
/** Registered renderers are trusted host code, not a sandbox. */
export type ExtensionRenderer = (container: HTMLElement, part: Extract<MessagePart, { kind: 'extension' }>,
    context: RenderContext) => MountedRenderer;
export interface ResourceCandidate { readonly id: string; readonly label: string; readonly insertText: string }
export interface ToolbarContext { readonly snapshot: ConversationSnapshot; readonly view: ChatView }
export interface MountedToolbar { update?(context: ToolbarContext): void; destroy(): void | Promise<void> }
export interface ChatOptions {
    readonly source: ConversationSource;
    readonly actions: ConversationActions;
    readonly operations: OperationLedger;
    /** Flow stays unavailable until enabled; its code is loaded when opened. */
    readonly features?: { readonly flow?: boolean };
    readonly flow?: FlowOptions;
    readonly initialDraft?: ComposerDraft;
    readonly onDraftChange?: (draft: ComposerDraft) => void;
    readonly saveDraft?: (draft: ComposerDraft) => Promise<void>;
    readonly assets?: AssetProvider;
    readonly onOpenResource?: (id: string) => Promise<void>;
    readonly upload?: (file: File, options: { signal: AbortSignal }) => Promise<AttachmentRef>;
    readonly searchResources?: (query: string, options: { signal: AbortSignal }) => Promise<readonly ResourceCandidate[]>;
    readonly renderers?: Readonly<Record<string, ExtensionRenderer>>;
    readonly mountToolbar?: (container: HTMLElement, context: ToolbarContext) => MountedToolbar;
    readonly translate?: (key: string) => string;
    readonly locale?: 'zh-CN' | 'en';
    readonly onError?: (error: unknown) => void;
}
export interface ChatView {
    setActive(active: boolean): void;
    setFlowEnabled(enabled: boolean): Promise<void>;
    focus(): void;
    getDraft(): ComposerDraft;
    setText(text: string): void;
    addFiles(files: readonly File[]): Promise<void>;
    submit(): Promise<void>;
    reconcile(operationId: string): Promise<void>;
    flushDraft(): Promise<void>;
    destroy(): Promise<void>;
}

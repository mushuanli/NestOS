export const DOCUMENT_CHAT_META_KEY = '_mindos_document_chat';
import type {IFileSystem} from '@itookit/vfs-core';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import type {TargetRef} from '@itookit/llm-flow/contracts';

export interface DocumentChatSource {
    namespaceId: string;
    fileIdentity?: string;
    path: string;
    projectFolder?: string;
    projectId?: string;
}
export interface DocumentChatBinding {
    sessionId: string;
    branch: string;
    initialRoundId: string;
    /** The response identity is derived from that immutable initial round, never the latest reply. */
    initialMessageId?: string;
}
export interface DocumentChatLink {
    schemaVersion: 1;
    id: string;
    documentId: string;
    anchorId: string;
    source: DocumentChatSource;
    selection: string;
    defaultPrompt: string;
    revision: number;
    status: 'unbound' | 'bound' | 'missing' | 'detached';
    endpoint?: {sessionId: string; branch: string};
    binding?: DocumentChatBinding;
    target?: TargetRef;
    latestRoundId?: string;
    /** A frozen pending request supports receipt reconciliation; it is not admission evidence. */
    pending?: SubmissionRequest;
    projectionPending?: boolean;
    createdAt: number;
    updatedAt: number;
}
export interface DocumentChatResponse {
    id: string;
    markdown: string;
    status: 'pending' | 'completed' | 'failed';
}
export interface DocumentChatFile {
    get(anchorId: string, includeResponse?: boolean): Promise<{link?: DocumentChatLink; response?: DocumentChatResponse; activity?: Omit<DocumentChatResponse, 'markdown'> & {operationId: string; markdown?: string}}>;
    create(anchorId: string, selection: string, defaultPrompt?: string): Promise<DocumentChatLink>;
    reserve(anchorId: string, operationId: string): Promise<DocumentChatLink>;
    prepare(anchorId: string, request: SubmissionRequest): Promise<void>;
    bind(anchorId: string, request: SubmissionRequest): Promise<DocumentChatLink>;
    reconcile(anchorIds: string[]): Promise<void>;
    subscribe(changed: () => void): () => void;
    dispose(): Promise<void>;
}
export interface DocumentChatFileRequest {files: IFileSystem; path: string; projectFolder?: string}

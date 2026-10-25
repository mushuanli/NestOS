import type { JsonValue } from '@itookit/llm-flow/contracts';
import type { RoundManifest } from './round-types';

export type { ChatSessionSettings } from '../contracts';
export { DEFAULT_SESSION_SETTINGS } from '../contracts';

export interface ConversationUIState {
    /** Opaque UI operation journal; execution and queue facts retain their existing authorities. */
    operationRecords?: JsonValue[];
    branchDrafts?: Record<string, {inputText?: string; inputAgentId?: string; inputTarget?: import('@itookit/llm-flow/contracts').TargetRef; inputArguments?: JsonValue; inputContext?: unknown; inputFiles?: JsonValue[]; inputToken?: string}>;
    collapseStates?: Record<string, boolean>;
    scrollPosition?: number;
    historyVisibility?: 'visible' | 'hidden';
}

export type SessionOrigin = 'cli' | 'tauri' | 'web';

export interface ConversationManifest extends RoundManifest {
    /** Existing storage revision; used for conditional UI writes, never an execution version. */
    readonly revision?: number;
    id: string;
    title: string;
    summary?: string;
    origin?: SessionOrigin;
    /** Agent selected when the host first materialized this identity; never inferred from later rounds. */
    createdWithAgentId?: string;
    createdAt: number;
    updatedAt: number;
    /** Virtual sidebar folder path, normalized as /A/B; null/undefined means root. */
    folder?: string | null;
    /** Organizational parent; history, drafts and executions remain independent. */
    parentSessionId?: string | null;
    uiState?: ConversationUIState;
    initialContext?: import('../contracts/content-transfer').ContentTransfer;
    /** Workflow instance source: set when the session is created from a workflow run. */
    flow?: {
        connectionBindings?: Record<string, string>;
        flowId: string;
        connectionId?: string;
        revision: number;
        parameters?: Record<string, JsonValue>;
    };
}

/** Navigation metadata only; history and editor state are loaded on demand. */
export type SessionSummary = Pick<ConversationManifest,
    'id' | 'title' | 'summary' | 'origin' | 'createdAt' | 'updatedAt' | 'folder' | 'parentSessionId' | 'createdWithAgentId'>;

export interface BranchTreeNode {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: number;
    isOnActivePath: boolean;
    memberOfBranches: string[];
    branchHead?: string;
    createdFrom?: 'regenerate' | 'edit' | 'manual';
    children: BranchTreeNode[];
}

export interface SessionFolder {
    path: string;
    name: string;
    parentPath: string | null;
    updatedAt: number;
    /** Local roots keep a directory; remote roots keep a logical project reference. */
    project?: { id: string; directory: string; source?: { kind: 'local' | 'remote' } };
}

/** A fresh, single-transaction snapshot for one editor load; never a persistent cache. */
export interface SessionLoadState {
    manifest: ConversationManifest;
    settings: import('../contracts').ChatSessionSettings;
}

/** Editor load projection plus the selected history chain, read in the same transaction. */
export interface SessionView extends SessionLoadState {
    chain: import('./history-chain').SessionHistoryChain;
}

export interface SessionRepositoryChange { kind: 'session' | 'ui-state'; sessionId?: string }

/** Required for recoverable structural changes; implementations cannot silently skip these steps. */
export interface SessionDeletionStore {
    assertStructuralWritable(ids: string[]): Promise<void>;
    prepareSessionDeletion(sessionId: string): Promise<void>;
    pendingSessionDeletions(): Promise<Array<{ id: string }>>;
}

export interface SessionCreation { agentId?: string; initialContext?: import('../contracts/content-transfer').ContentTransfer }

/** Domain storage. History and attachments belong to the Session identity. */
export interface ISessionRepository extends SessionDeletionStore {
    init(): Promise<void>;
    dispose(): Promise<void>;
    subscribe(listener: (change?: SessionRepositoryChange) => void): () => void;
    createSession(title: string, folder?: string | null, parentSessionId?: string | null, initialState?: ConversationUIState, creation?: SessionCreation): Promise<string>;
    /** Idempotently create a Session with a host-supplied durable identity. */
    ensureSession(id: string, title: string, origin?: SessionOrigin, folder?: string | null, parentSessionId?: string | null,
        creation?: SessionCreation): Promise<string>;
    getManifest(sessionId: string): Promise<ConversationManifest>;
    getLoadState?(sessionId: string): Promise<SessionLoadState>;
    /** Read the projection and the selected history chain together, when supported. */
    loadView?(sessionId: string): Promise<SessionView>;
    /** Read the selected history chain in one storage snapshot when supported. */
    readHistoryChain?(sessionId: string): Promise<import('./history-chain').SessionHistoryChain>;
    list(): Promise<ConversationManifest[]>;
    /** Read navigation metadata without loading history indexes, when supported. */
    listSummaries?(): Promise<SessionSummary[]>;
    /** Read only the direct Session rows of a navigation directory. */
    listSummariesInFolder?(folder: string | null): Promise<SessionSummary[]>;
    /** Delete a Session and its owned storage. */
    deleteSession(sessionId: string): Promise<void>;
    listFolders(): Promise<SessionFolder[]>;
    promoteProjectFolder?(path: string, project: NonNullable<SessionFolder['project']>): Promise<void>;
    setStorageDirectoryResolver?(resolver: (folder: string | null) => Promise<string | undefined>): void;
    relocateProjectStorage?(id: string): Promise<void>;
    indexProjectSessions?(directory: string): Promise<void>;
    /** Check copied directory identities without publishing their storage locations. */
    validateProjectSessions?(directory: string): Promise<void>;
    createFolder(path: string, project?: SessionFolder['project']): Promise<SessionFolder>;
    replaceProjectReference?(path: string, expected: NonNullable<SessionFolder['project']>, next: NonNullable<SessionFolder['project']>): Promise<void>;
    deleteFolder(path: string, recursive?: boolean): Promise<void>;
    renameFolder(from: string, to: string): Promise<void>;
    updateManifest(sessionId: string, patch: Partial<ConversationManifest>): Promise<void>;
    getUIState(sessionId: string): Promise<ConversationUIState | null>;
    updateUIState(sessionId: string, patch: Partial<ConversationUIState>): Promise<void>;
    /** Atomic condition on the existing Session revision; absence is not permission to overwrite. */
    compareAndSetUIState?(sessionId: string, expectedRevision: number, patch: Partial<ConversationUIState>): Promise<void>;
    getSessionSettings(sessionId: string): Promise<import('../contracts').ChatSessionSettings>;
    saveSessionSettings(sessionId: string, patch: Partial<import('../contracts').ChatSessionSettings>): Promise<void>;
    readDocument(sessionId: string, name: string): Promise<string | null>;
    writeDocument(sessionId: string, name: string, content: string): Promise<void>;
    listHistory(sessionId: string): Promise<string[]>;
    writeAttachment(sessionId: string, name: string, content: ArrayBuffer): Promise<void>;
    openAttachments(sessionId: string): Promise<import('@itookit/vfs-core').FileSystemView>;
    readSessionAsset(sessionId: string, name: string): Promise<Blob | null>;
}

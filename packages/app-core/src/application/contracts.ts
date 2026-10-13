import type { InteractionRecord, JsonValue } from '@itookit/durable-kernel';
import type { FSErrorCode, FSNode } from '@itookit/vfs-core';
import type { ConversationManifest, SessionSummary, SessionSnapshot, SessionEventEnvelope, RegistryEvent } from '@itookit/llm-session/contracts';

export const APPLICATION_PROTOCOL_VERSION = 1;
export type WorkspaceIdentity = { kind: 'workspace'; name: string } | { kind: 'project'; id: string };
export interface DirectoryQuery { workspace: WorkspaceIdentity; path: string; offset?: number; limit?: number }
export interface DirectoryPage { entries: FSNode[]; nextOffset?: number }
export interface ApplicationCapabilities {
    protocol: number;
    workspaces: string[];
    commands: string[];
    events: boolean;
    receipts: boolean;
}
export interface CommandReceipt { id: string; name: string; state: 'pending' | 'completed' | 'failed'; createdAt: number; result?: JsonValue; error?: { code: FSErrorCode; message: string } }
export interface ApplicationFolder { path: string; name: string; parentPath: string | null; projectId?: string }
export interface ApplicationQueries {
    entry: { input: { workspace: WorkspaceIdentity; path: string }; output: FSNode | null };
    session: { input: { sessionId: string }; output: SessionSummary };
    navigation: { input: { folder: string | null }; output: { folders: ApplicationFolder[]; sessions: SessionSummary[] } };
    receipt: { input: { requestId: string }; output: CommandReceipt | null };
    capabilities: { input: undefined; output: ApplicationCapabilities };
    directory: { input: DirectoryQuery; output: DirectoryPage };
    file: { input: { workspace: WorkspaceIdentity; path: string; encoding?: 'text' | 'base64' }; output: { content: string; encoding: 'text' | 'base64'; revision?: string } };
    sessions: { input: { folder?: string | null }; output: SessionSummary[] };
    conversation: { input: { sessionId: string; before?: string; limit?: number }; output: { manifest: ConversationManifest; snapshot: SessionSnapshot; writable: boolean; revision: number; hasEarlier: boolean; interactions: Array<{ taskId: string; request: InteractionRecord<JsonValue> }> } };
}
export interface ApplicationCommands {
    createConversation: { input: { title: string; folder?: string | null }; output: { sessionId: string } };
    conversation: { input: { sessionId: string; name: string; args?: JsonValue }; output: unknown };
    respond: { input: { sessionId: string; taskId: string; interactionId: string; value: JsonValue }; output: void };
    cancelTask: { input: { sessionId: string; taskId: string }; output: void };
    saveFile: { input: { workspace: WorkspaceIdentity; path: string; content: string; revision?: string }; output: { revision?: string } };
}
export type ApplicationChange = { kind: 'session'; sessionId: string; event: SessionEventEnvelope } | { kind: 'registry'; event: RegistryEvent } | { kind: 'invalidate'; scope: 'sessions' | 'files' | 'all' };
export type ApplicationEvent = ApplicationChange & { revision: number };

/** Local and remote adapters share capabilities; the transport is not a business interface. */
export interface ApplicationPort {
    query<K extends keyof ApplicationQueries>(name: K, input: ApplicationQueries[K]['input'], signal?: AbortSignal): Promise<ApplicationQueries[K]['output']>;
    command<K extends keyof ApplicationCommands>(name: K, input: ApplicationCommands[K]['input'], signal?: AbortSignal, requestId?: string): Promise<ApplicationCommands[K]['output']>;
    subscribe(listener: (event: ApplicationEvent) => void): () => void;
    /** Release this client's subscriptions and view state; never stop the owning runtime. */
    close(): Promise<void>;
}

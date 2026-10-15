import type { RetrievedMemoryEntry } from '@itookit/llm-context';
import type { MemoryPolicy } from '@itookit/llm-tasks/contracts';
import type { SessionViewPort } from './session-view';
import type { SessionRuntime, SessionSnapshot } from '../core/types';

type Reference = NonNullable<MemoryPolicy['sharedMemory']>;
export interface MemoryEntry extends RetrievedMemoryEntry { scope: string; updatedAt: number; revision: string;
    source?: { sessionId: string; taskId?: string; effectId?: string };
    compression?: { version: 1; sources: Array<{ entryId: string; revision: string; contentHash: string }>; model?: string }; }
export interface MemoryWrite { entryId: string; scope: string; content: string; }
/** Omit for unconditional writes; null requires absence, a hash requires matching content. */
export interface MemoryMutationOptions { expectedContentHash?: string | null; expectedRevision?: string | null; origin?: MemoryOrigin; }
export interface MemoryCompressionSource { entryId: string; revision: string; }

export interface MemoryOrigin { operationId: string; taskId?: string; effectId?: string; }
export interface SharedMemoryGrant { readScopes: string[]; writeScopes: string[]; }
export interface SharedMemoryResource extends Reference {
    namespaceId: string;
    creatorSessionId: string;
    revision: number;
    deleted: boolean;
    grants: Record<string, SharedMemoryGrant>;
}
export interface SharedMemoryAudit {
    action: string; sessionId: string; at: number; resourceRevision: number;
    scope?: string; origin?: MemoryOrigin; dataVersion?: number;
}

/** Host management interfaces do not depend on memory stores or SessionManager. */
export interface MemorySharingControls {
    state(agentId: string): Promise<{ policy: MemoryPolicy; sessionId: string; resources: SharedMemoryResource[] }>;
    create(agentId: string, id: string): Promise<Reference>;
    use(agentId: string, ref: Reference | null): Promise<void>;
    grant(agentId: string, targetSessionId: string, writable: boolean): Promise<void>;
    revoke(agentId: string, targetSessionId: string): Promise<void>;
    remove(agentId: string): Promise<void>;
    audit(agentId: string): Promise<SharedMemoryAudit[]>;
}

export interface SessionMemoryControls {
    readonly sharing: MemorySharingControls;
    forSession(sessionId: string): SessionMemoryControls | Promise<SessionMemoryControls>;
    list(agentId: string): Promise<MemoryEntry[]>;
    upsert(agentId: string, entry: MemoryWrite, options?: MemoryMutationOptions): Promise<void>;
    remove(agentId: string, scope: string, entryId: string, options?: MemoryMutationOptions): Promise<void>;
}

export interface SessionManagementPort extends SessionViewPort {
    readonly memory: SessionMemoryControls;
    getSnapshot(): SessionSnapshot;
    getSessionRuntime(id: string): SessionRuntime | undefined;
    getAvailableAgents(): Promise<Array<{ id: string; name: string; icon?: string; category?: string; description?: string }>>;
}

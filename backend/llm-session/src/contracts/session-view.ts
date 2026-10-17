import type { SessionGroup, SessionStatus, SessionEventEnvelope, RegistryEvent, SessionSnapshot } from '../core/types';
import type { ISession } from './session';
import type { PromptHistoryEntry } from './prompt-history';

export interface PromptHistoryPort {
    getRecent(count?: number): Promise<PromptHistoryEntry[]>;
    add(text: string, options?: { agentId?: string; sessionId?: string }): Promise<void>;
    remove(text: string): Promise<boolean>;
}

/** The editor needs observation and a command channel, not a session implementation. */
export interface SessionViewPort extends ISession {
    /** Latest observed memory projection; reading never binds or performs I/O. */
    getSnapshot?(): SessionSnapshot;
    getDirectAgentPolicy?(): import('./direct-agent-policy').ResolvedDirectAgentPolicy;
    getSessions(): SessionGroup[];
    getStatus(): SessionStatus | 'unbound';
    isGenerating(): boolean;
    onEvent(handler: (event: SessionEventEnvelope) => void): () => void;
    onGlobalEvent(handler: (event: RegistryEvent) => void): () => void;
    readonly promptHistory?: PromptHistoryPort;
}

/** A file attachment associated with a conversation message. */
export interface ChatAttachment {
    name: string;
    type: string;
    path?: string;
    size?: number;
    /** Runtime file reference; never persisted. */
    fileRef?: File | Blob;
}

/** Per-conversation UI execution preferences. */
import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';
export type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export interface ChatSessionSettings {
    /** Omitted means follow the global default connection. */
    connectionId?: string;
    executionMode?: ChatExecutionMode;
    /** Fixed after the first accepted direct run. */
    executionModeLocked?: boolean;
    version: '1.0';
    modelId?: string;
    historyLength: number;
    temperature?: number;
    streamMode: boolean;
    updatedAt?: string;
}

export const DEFAULT_SESSION_SETTINGS: ChatSessionSettings = {
    executionMode: 'chat',
    executionModeLocked: false,
    version: '1.0',
    modelId: undefined,
    historyLength: -1,
    temperature: undefined,
    streamMode: true,
};

import type {Attachment} from '@itookit/llm-context';
/** A file attachment associated with a conversation message. */
export interface ChatAttachment {
    name: string;
    type: string;
    path?: string;
    size?: number;
    /** Expected immutable content. Host admission verifies rather than trusts it. */
    content?: AttachmentContentIdentity;
    /** Runtime file reference; never persisted. */
    fileRef?: File | Blob;
}

export interface AttachmentContentIdentity { sha256: string; bytes: number; }

export function isAttachmentContentIdentity(value: unknown): value is AttachmentContentIdentity {
    if (!value || typeof value !== 'object') return false;
    const record = value as AttachmentContentIdentity;
    return typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256)
        && Number.isSafeInteger(record.bytes) && record.bytes >= 0
        && Object.keys(record).every(key => key === 'sha256' || key === 'bytes');
}

/** Preserve old request digests when content identity was not supplied. */
export function attachmentMetadata(file: ChatAttachment): Omit<ChatAttachment, 'fileRef'> {
    return {name: file.name, type: file.type, path: file.path, size: file.size,
        ...(file.content !== undefined ? {content: {...file.content}} : {})};
}

export function historyAttachment(attachment: Attachment, fallbackMimeType = ''): ChatAttachment {
    const name = attachment.name ?? attachment.filename ?? (typeof attachment.source === 'string' ? attachment.source : '');
    const content = attachment.options?.contentIdentity;
    if (content !== undefined && !isAttachmentContentIdentity(content))
        throw Object.assign(new Error('Stored attachment content identity is invalid'), {code: 'ATTACHMENT_INVALID'});
    return {name, type: attachment.mimeType || (attachment.type.includes('/') ? attachment.type : fallbackMimeType || attachment.type),
        size: attachment.size, ...(content !== undefined ? {content} : {})};
}

/** Per-conversation UI execution preferences. */
import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';
export type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export interface ChatSessionSettings {
    imageResize?: import('@itookit/kernel-adapters/contracts').ImageResizePolicy;
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

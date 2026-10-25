import {attachmentToContentPart, expandMessageAttachments, isSupportedTextContent} from '@itookit/driver-llm';
import {guessMimeType} from '@itookit/vfs-core';
import type {ChatMessage, Attachment} from '@itookit/llm-context';
import {historyAttachment, type ChatAttachment} from '../contracts/chat';
import type {ISessionRepository} from '../persistence/types';
import {attachmentError, readVerifiedAttachment} from './attachment-integrity';

/** History keeps durable references; provider messages contain verified serializable parts. */
export function conversationUserMessage(text: string, files: ChatAttachment[]): ChatMessage {
    return {role: 'user', content: text, ...(files.length ? {attachments: files.map(file => ({
        name: file.name, filename: file.name, source: file.name, size: file.size,
        type: attachmentType(file.type || guessMimeType(file.name)), mimeType: file.type || guessMimeType(file.name),
        ...(file.content ? {options: {contentIdentity: {...file.content}}} : {}),
    }))} : {})};
}

export async function materializeAttachmentMessage(engine: ISessionRepository, sessionId: string, message: ChatMessage): Promise<ChatMessage> {
    if (!message.attachments?.length) return message;
    const attachments: Attachment[] = [];
    for (const attachment of message.attachments) {
        const file = historyAttachment(attachment, guessMimeType(attachment.name ?? attachment.filename ?? ''));
        attachments.push({type: attachmentType(file.type), source: await readVerifiedAttachment(engine, sessionId, file),
            filename: file.name, mimeType: file.type});
    }
    try { return await expandMessageAttachments({...message, attachments}); }
    catch { throw attachmentError('ATTACHMENT_ENCODING_FAILED', 'Attachment format cannot be prepared for model input'); }
}

/** Native inputs retain file boundaries instead of duplicating them inside prompt text. */
export async function materializeHarnessMessage(engine: ISessionRepository, sessionId: string, message: ChatMessage): Promise<ChatMessage> {
    if (!message.attachments?.length) return message;
    const attachments: Attachment[] = [];
    for (const attachment of message.attachments) {
        const file = historyAttachment(attachment, guessMimeType(attachment.name ?? attachment.filename ?? ''));
        const blob = await readVerifiedAttachment(engine, sessionId, file);
        attachments.push(await inlineNativeAttachment(file, blob));
    }
    return {...message, attachments};
}

async function inlineNativeAttachment(file: ChatAttachment, source: Blob): Promise<Attachment> {
    const base = {name: file.name, filename: file.name, mimeType: source.type, size: source.size,
        ...(file.content ? {options: {contentIdentity: {...file.content}}} : {})};
    if (isSupportedTextContent(source.type)) {
        try {return {...base, type: 'text', source: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await source.arrayBuffer())};}
        catch {throw attachmentError('HARNESS_ATTACHMENT_TEXT_ENCODING', 'Native text attachments require valid UTF-8 content');}
    }
    if (!source.type.startsWith('image/')) throw attachmentError('HARNESS_ATTACHMENT_MEDIA_UNSUPPORTED', 'This Harness input requires text or image content; convert other file formats explicitly');
    const part = await attachmentToContentPart({type: 'image', source, mimeType: source.type});
    if (part.type !== 'image_url' || !part.image_url?.url) throw attachmentError('HARNESS_ATTACHMENT_ENCODING', 'Cannot prepare the image for native input');
    return {...base, type: 'image', source: part.image_url.url};
}

function attachmentType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
}

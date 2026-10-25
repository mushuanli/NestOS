import {guessMimeType} from '@itookit/vfs-core';
import type {Attachment} from '@itookit/llm-context';
import {attachmentMetadata, type ChatAttachment} from '../contracts/chat';
import type {ISessionRepository} from '../persistence/types';
import {createSessionHost, type SessionLogger} from '../utils/host-ports';
import {attachmentCauseCode, attachmentError, readVerifiedAttachment} from './attachment-integrity';
import {MarkdownAnalyzer} from './MarkdownAnalyzer';

/** Resolve declared and Markdown attachments without silently losing required input. */
export class AttachmentProcessor {
    private readonly markdownAnalyzer = new MarkdownAnalyzer();
    constructor(private readonly engine: ISessionRepository,
        private readonly logger: SessionLogger = createSessionHost().logger) {}

    async resolveAttachments(sessionId: string, text: string, inputFiles: ChatAttachment[]): Promise<ChatAttachment[]> {
        const analysis = await this.markdownAnalyzer.analyze(text, {filePath: 'message.md'});
        const files = [...inputFiles], names = new Set(files.map(file => file.name));
        if (names.size !== files.length) throw attachmentError('ATTACHMENT_DUPLICATE_NAME', 'Attachment names must be distinct within a submission');
        for (const name of analysis.references) {
            if (names.has(name)) continue;
            const file = await this.loadFromStorage(sessionId, name, analysis.requiredReferences.includes(name));
            if (file) { files.push(file); names.add(name); }
        }
        const result: ChatAttachment[] = [];
        for (const file of files) result.push({...attachmentMetadata(file), fileRef: await this.read(sessionId, file)});
        return result;
    }

    async convertToAttachments(sessionId: string, files: ChatAttachment[]): Promise<Attachment[]> {
        const attachments: Attachment[] = [];
        for (const file of files) {
            const mimeType = file.type || guessMimeType(file.name);
            attachments.push({type: this.mimeToAttachmentType(mimeType), source: await this.read(sessionId, file),
                mimeType, filename: file.name});
        }
        return attachments;
    }

    async resolveHistoryAttachment(sessionId: string, file: ChatAttachment): Promise<Attachment | null> {
        return (await this.convertToAttachments(sessionId, [file]))[0];
    }

    stripFileRefs(files: ChatAttachment[]): Omit<ChatAttachment, 'fileRef'>[] { return files.map(attachmentMetadata); }

    mimeToAttachmentType(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType.startsWith('video/')) return 'video';
        return 'file';
    }

    private async loadFromStorage(sessionId: string, name: string, required: boolean): Promise<ChatAttachment | null> {
        let blob: Blob | null;
        try { blob = await this.engine.readSessionAsset(sessionId, name); }
        catch (error) {
            this.logger.warn('Attachment reference read failed', {operation: 'session.attachments', sessionId,
                stage: 'reference-read', outcome: 'failure', code: 'ATTACHMENT_READ_FAILED', causeCode: attachmentCauseCode(error)});
            throw attachmentError('ATTACHMENT_READ_FAILED', 'Cannot read a referenced attachment', error);
        }
        if (!blob) {
            if (required) throw attachmentError('ATTACHMENT_NOT_FOUND', 'A referenced @asset attachment is missing; restore or remove its reference');
            return null;
        }
        return {name, type: blob.type || guessMimeType(name), size: blob.size, fileRef: blob};
    }

    private async read(sessionId: string, file: ChatAttachment): Promise<Blob> {
        const started = Date.now();
        try { return await readVerifiedAttachment(this.engine, sessionId, file); }
        catch (error) {
            this.logger.warn('Attachment verification failed', {operation: 'session.attachments', sessionId,
                stage: 'content-verify', outcome: 'failure', code: (error as {code?: string}).code, causeCode: (error as {causeCode?: string}).causeCode,
                durationMs: Date.now() - started});
            throw error;
        }
    }
}

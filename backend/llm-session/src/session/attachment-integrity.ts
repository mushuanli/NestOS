import {sha256Hex} from '@itookit/llm-context';
import {guessMimeType} from '@itookit/vfs-core';
import {attachmentMetadata, isAttachmentContentIdentity, type ChatAttachment} from '../contracts/chat';
import type {ISessionRepository} from '../persistence/types';
import type {SessionLogger} from '../utils/host-ports';

export function attachmentError(code: string, message: string, cause?: unknown): Error {
    return Object.assign(new Error(message), {code, ...(attachmentCauseCode(cause) ? {causeCode: attachmentCauseCode(cause)} : {})});
}

export function attachmentCauseCode(error: unknown): string | undefined {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EROFS', 'EEXIST', 'EINVAL',
        'ENODEV', 'EDQUOT', 'EBUSY', 'ETIMEDOUT', 'ABORT_ERR'].includes(code) ? code : undefined;
}

/** Runtime Blob input needs a content identity before computing the request digest. */
export async function identifyRuntimeAttachments(files: ChatAttachment[]): Promise<ChatAttachment[]> {
    return Promise.all(files.map(async file => {
        if (!file.fileRef) return file;
        let bytes: ArrayBuffer;
        try { bytes = await file.fileRef.arrayBuffer(); }
        catch { throw attachmentError('ATTACHMENT_READ_FAILED', 'Cannot read attachment content before submission'); }
        const content = {sha256: await sha256Hex(bytes), bytes: bytes.byteLength};
        if (file.content && (file.content.bytes !== content.bytes || file.content.sha256 !== content.sha256))
            throw attachmentError('ATTACHMENT_CONTENT_MISMATCH', 'Attachment content differs from the submitted content identity');
        return {...file, content};
    }));
}

export async function readVerifiedAttachment(engine: ISessionRepository, sessionId: string, file: ChatAttachment): Promise<Blob> {
    assertAttachment(file);
    let source: Blob | null;
    try { source = file.fileRef ?? await engine.readSessionAsset(sessionId, file.name); }
    catch (error) { throw attachmentError('ATTACHMENT_READ_FAILED', 'Cannot read the submitted attachment; restore it before retrying', error); }
    if (!source) throw attachmentError('ATTACHMENT_NOT_FOUND', 'A submitted attachment is missing; restore or remove it before retrying');
    let bytes: ArrayBuffer;
    try { bytes = await source.arrayBuffer(); }
    catch { throw attachmentError('ATTACHMENT_READ_FAILED', 'Cannot read the submitted attachment content'); }
    await assertAttachmentBody(file, bytes);
    return new Blob([bytes], {type: file.type || source.type || guessMimeType(file.name)});
}

async function assertAttachmentBody(file: ChatAttachment, bytes: ArrayBuffer): Promise<void> {
    if (file.size !== undefined && file.size !== bytes.byteLength
        || file.content && (file.content.bytes !== bytes.byteLength || file.content.sha256 !== await sha256Hex(bytes)))
        throw attachmentError('ATTACHMENT_CONTENT_MISMATCH', 'Attachment content changed; submit a new request with the intended file');
}

function assertAttachment(file: ChatAttachment): void {
    if (!file || !validAttachmentName(file.name) || typeof file.type !== 'string' || !validAttachmentSize(file.size)
        || file.content !== undefined && !isAttachmentContentIdentity(file.content))
        throw attachmentError('ATTACHMENT_INVALID', 'Invalid attachment metadata or content identity');
}
function validAttachmentName(name: unknown): boolean {
    return typeof name === 'string' && !!name && !/[/\\\0]/.test(name) && !['.', '..'].includes(name);
}
function validAttachmentSize(size: number | undefined): boolean {return size === undefined || Number.isSafeInteger(size) && size >= 0;}

/** Copy into the existing Session attachment store before queue acceptance. */
export async function freezeAttachments(engine: ISessionRepository, sessionId: string, operationId: string,
    files: ChatAttachment[], logger: SessionLogger): Promise<ChatAttachment[]> {
    const snapshots: ChatAttachment[] = [];
    for (const [index, file] of files.entries()) {
        const started = Date.now(); let stage = 'attachment-read';
        try {
            const blob = await readVerifiedAttachment(engine, sessionId, file), bytes = await blob.arrayBuffer();
            const content = {sha256: await sha256Hex(bytes), bytes: bytes.byteLength};
            const name = `${operationId}-${index}-${content.sha256}${file.name.match(/\.[a-zA-Z0-9]{1,16}$/)?.[0] ?? ''}`;
            const snapshot = {...attachmentMetadata(file), name, path: `./${name}`, size: content.bytes, content};
            stage = 'attachment-write';
            await writeSnapshot(engine, sessionId, snapshot, bytes);
            snapshots.push(snapshot);
            logger.debug('Instruction attachment frozen', {operation: 'session.instructions', operationId, sessionId, stage,
                outcome: 'success', index, bytes: content.bytes, durationMs: Date.now() - started});
        } catch (error) {
            const code = (error as {code?: string})?.code ?? 'ATTACHMENT_PREPARATION_FAILED';
            logger.warn('Instruction attachment preparation failed', {operation: 'session.instructions', operationId, sessionId, stage,
                outcome: 'failure', code, causeCode: (error as {causeCode?: string})?.causeCode, index, durationMs: Date.now() - started});
            throw error;
        }
    }
    return snapshots;
}

async function writeSnapshot(engine: ISessionRepository, sessionId: string, file: ChatAttachment, bytes: ArrayBuffer): Promise<void> {
    let writeFailed = false, cause: unknown;
    try { await engine.writeAttachment(sessionId, file.name, bytes); } catch (error) { writeFailed = true; cause = error; }
    try { await readVerifiedAttachment(engine, sessionId, file); }
    catch (error) {
        if (!writeFailed || (error as {code?: string}).code === 'ATTACHMENT_CONTENT_MISMATCH') throw error;
        throw attachmentError('ATTACHMENT_WRITE_UNCONFIRMED', 'Attachment persistence is unconfirmed; retry preparation with the same submission identity', cause);
    }
}

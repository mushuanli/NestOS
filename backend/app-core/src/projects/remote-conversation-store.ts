import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { HarnessAttachment, HarnessRecovery } from '@itookit/mindos-node-driver';
export interface RemoteConversationRecovery extends HarnessRecovery { submittedTurnId?: string }
/** Persist native references and pending receipts; never native conversation histories. */
export class RemoteConversationStore {
    private raw: string | null = null;
    private record: RemoteConversationRecovery = {};
    constructor(private readonly fs: IFileSystem, private readonly key: string) {}
    private readonly path = '/etc/fs/harness-conversations.seq';
    async load(): Promise<RemoteConversationRecovery | undefined> {
        if (!await this.fs.driver.exists(this.path)) { this.record = {}; this.raw = null; return; }
        this.raw = await this.fs.meta.seq!.getEntry(this.path, this.key);
        if (!this.raw) { this.record = {}; return; }
        const record = JSON.parse(this.raw) as RemoteConversationRecovery;
        validateSubmissions(record);
        if (record.submittedTurnId !== undefined && (typeof record.submittedTurnId !== 'string' || !record.submittedTurnId))
            throw new FSError('EINVAL', 'Invalid remote submission receipt');
        if (record.draft !== undefined && (typeof record.draft !== 'string' || record.draft.length > 1024 * 1024)) throw new FSError('EINVAL', 'Invalid remote input draft');
        if (record.pending?.inputText !== undefined && (typeof record.pending.inputText !== 'string' || record.pending.inputText.length > 1024 * 1024))
            throw new FSError('EINVAL', 'Invalid remote command input');
        if (record.sessionId !== undefined && typeof record.sessionId !== 'string' || record.pending &&
            (!record.pending.requestId || typeof record.pending.epoch !== 'string' || typeof record.pending.operation !== 'string')) throw new FSError('EINVAL', 'Invalid remote conversation recovery');
        if (record.deletedSessionIds !== undefined && (!Array.isArray(record.deletedSessionIds) || record.deletedSessionIds.length > 16401
            || record.deletedSessionIds.some(id => typeof id !== 'string' || !id))) throw new FSError('EINVAL', 'Invalid native deletion recovery');
        validateAttachments(record.draftAttachments);
        this.record = record; return record;
    }
    get submittedTurnId(): string | undefined { return this.record.submittedTurnId; }
    async submitted(turnId: string): Promise<void> { await this.save({...this.record, submittedTurnId: turnId}); }
    async save(record: RemoteConversationRecovery): Promise<void> {
        validateSubmissions(record);
        if (record.deletedSessionIds !== undefined && (!Array.isArray(record.deletedSessionIds) || record.deletedSessionIds.length > 16401
            || record.deletedSessionIds.some(id => typeof id !== 'string' || !id))) throw new FSError('EINVAL', 'Invalid native deletion recovery');
        validateAttachments(record.draftAttachments);
        if (!await this.fs.driver.exists(this.path)) {
            try { await this.fs.driver.createFile({parentPath: '/etc/fs', name: 'harness-conversations.seq', type: 'seqfile', recursive: true}); }
            catch (error) { if ((error as {code?: string}).code !== 'EEXIST') throw error; }
        }
        const value = JSON.stringify(record);
        await this.fs.meta.seq!.transaction!(async tx => {
            if (!await tx.compareAndSet(this.path, this.key, {expected: this.raw, value})) throw new FSError('ECONFLICT', 'Remote conversation is controlled by another view');
        });
        this.raw = value;
        this.record = record;
    }
}

function validateSubmissions(record: RemoteConversationRecovery): void {
    if (record.responses !== undefined && (!Array.isArray(record.responses) || record.responses.length > 128
        || record.responses.some(row => !row || !['string', 'number'].includes(typeof row.id)
            || typeof row.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.requestId) || typeof row.epoch !== 'string' || !row.epoch)))
        throw new FSError('EINVAL', 'Invalid native response receipts');
    for (const revision of [record.draftRevision, record.pending?.draftRevision]) {
        if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new FSError('EINVAL', 'Invalid remote draft revision');
    }
    if (record.commandResults === undefined) return;
    if (!Array.isArray(record.commandResults) || record.commandResults.length > 64) throw new FSError('EINVAL', 'Invalid command receipts');
    for (const result of record.commandResults) {
        if (!result || typeof result.commandId !== 'string' || !result.commandId || result.commandId.length > 1024
            || typeof result.output !== 'string' || result.output.length > 128 * 1024
            || result.failed !== undefined && typeof result.failed !== 'boolean') throw new FSError('EINVAL', 'Invalid command receipt');
    }
}

function validateAttachments(value: unknown): asserts value is HarnessAttachment[] | undefined {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 5) throw new FSError('EINVAL', 'Invalid native draft attachments');
    let total = 0;
    for (const attachment of value) {
        if (!attachment || !['text', 'image'].includes(attachment.kind) || typeof attachment.name !== 'string' || typeof attachment.content !== 'string')
            throw new FSError('EINVAL', 'Invalid native draft attachment');
        if (!attachment.name || /[\x00-\x1f\x7f/\\]/.test(attachment.name) || new TextEncoder().encode(attachment.name).byteLength > 256)
            throw new FSError('EINVAL', 'Invalid native attachment name');
        const size = new TextEncoder().encode(attachment.content).byteLength; total += size;
        if (attachment.kind === 'text' && (size > 64 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(attachment.content)))
            throw new FSError('EINVAL', 'Invalid native text attachment');
        if (attachment.kind === 'image' && (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mimeType) || !attachment.content.startsWith(`data:${attachment.mimeType};base64,`) || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content.split(',')[1] ?? '') || size > 350 * 1024))
            throw new FSError('EINVAL', 'Invalid native image attachment');
    }
    if (total > 512 * 1024) throw new FSError('EFBIG', 'Native attachment draft too large');
}

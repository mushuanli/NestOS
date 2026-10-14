import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { HarnessAttachment, HarnessRecovery } from '@itookit/piagent-driver';
/** Persist native references and pending receipts; never native conversation histories. */
export class RemoteConversationStore {
    private raw: string | null = null;
    constructor(private readonly fs: IFileSystem, private readonly key: string) {}
    private readonly path = '/etc/fs/harness-conversations.seq';
    async load(): Promise<HarnessRecovery | undefined> {
        if (!await this.fs.driver.exists(this.path)) return;
        this.raw = await this.fs.meta.seq!.getEntry(this.path, this.key);
        if (!this.raw) return;
        const record = JSON.parse(this.raw) as HarnessRecovery;
        if (record.draft !== undefined && (typeof record.draft !== 'string' || record.draft.length > 1024 * 1024)) throw new FSError('EINVAL', 'Invalid remote input draft');
        if (record.sessionId !== undefined && typeof record.sessionId !== 'string' || record.pending &&
            (!record.pending.requestId || typeof record.pending.epoch !== 'string' || typeof record.pending.operation !== 'string')) throw new FSError('EINVAL', 'Invalid remote conversation recovery');
        if (record.deletedSessionIds !== undefined && (!Array.isArray(record.deletedSessionIds) || record.deletedSessionIds.length > 16401
            || record.deletedSessionIds.some(id => typeof id !== 'string' || !id))) throw new FSError('EINVAL', 'Invalid native deletion recovery');
        validateAttachments(record.draftAttachments);
        return record;
    }
    async save(record: HarnessRecovery): Promise<void> {
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

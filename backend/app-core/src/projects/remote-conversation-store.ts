import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { HarnessAttachment, HarnessRecovery } from '@itookit/nestos-node-driver';
export interface RemoteConversationRecovery extends HarnessRecovery { submittedTurnId?: string }
/** Persist native references and pending receipts; never native conversation histories. */
export class RemoteConversationStore {
    private raw: string | null = null;
    private record: RemoteConversationRecovery = {};
    private uncertainWrite?: {before: string | null; after: string};
    private conflicted = false;
    private writes: Promise<void> = Promise.resolve();
    constructor(private readonly fs: IFileSystem, private readonly key: string) {}
    private readonly path = '/etc/fs/harness-conversations.seq';
    load(): Promise<RemoteConversationRecovery | undefined> {
        return this.serialize(() => this.read());
    }
    private async read(): Promise<RemoteConversationRecovery | undefined> {
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
        this.record = record; return structuredClone(record);
    }
    get submittedTurnId(): string | undefined { return this.record.submittedTurnId; }
    submitted(turnId: string): Promise<void> {
        return this.serialize(async () => {
            await this.reconcileWrite();
            await this.write({...this.record, submittedTurnId: turnId});
        });
    }
    save(record: RemoteConversationRecovery): Promise<void> {
        const frozen = structuredClone(record);
        return this.serialize(() => this.write(frozen));
    }
    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const work = this.writes.then(operation); this.writes = work.then(() => {}, () => {}); return work;
    }
    private async write(record: RemoteConversationRecovery): Promise<void> {
        await this.reconcileWrite();
        this.checkQueueRevision(record);
        validateSubmissions(record);
        if (record.deletedSessionIds !== undefined && (!Array.isArray(record.deletedSessionIds) || record.deletedSessionIds.length > 16401
            || record.deletedSessionIds.some(id => typeof id !== 'string' || !id))) throw new FSError('EINVAL', 'Invalid native deletion recovery');
        validateAttachments(record.draftAttachments);
        if (!await this.fs.driver.exists(this.path)) {
            try { await this.fs.driver.createFile({parentPath: '/etc/fs', name: 'harness-conversations.seq', type: 'seqfile', recursive: true}); }
            catch (error) { if ((error as {code?: string}).code !== 'EEXIST') throw error; }
        }
        const value = JSON.stringify(record);
        const before = this.raw, started = Date.now();
        try {
            await this.fs.meta.seq!.transaction!(async tx => {
                if (!await tx.compareAndSet(this.path, this.key, {expected: before, value})) throw new FSError('ECONFLICT', 'Remote conversation is controlled by another view');
            });
        } catch (error) {
            this.uncertainWrite = {before, after: value};
            this.log('persist', started, record, error); throw error;
        }
        this.raw = value;
        this.record = record;
    }
    private checkQueueRevision(record: RemoteConversationRecovery): void {
        const before = this.record.instructionQueue, after = record.instructionQueue;
        if (!before) return;
        const stale = !after ? before.items.length > 0 : after.revision < before.revision
            || after.revision === before.revision && JSON.stringify(after) !== JSON.stringify(before);
        if (stale) {
            const error = new FSError('ECONFLICT', 'Persisted instruction queue changed; refresh before saving');
            this.log('queue-revision', Date.now(), record, error); throw error;
        }
    }
    private async reconcileWrite(): Promise<void> {
        if (this.conflicted) throw new FSError('ECONFLICT', 'Remote conversation recovery conflicts with another writer');
        if (!this.uncertainWrite) return;
        const started = Date.now(), {before, after} = this.uncertainWrite;
        const actual = await this.fs.meta.seq!.getEntry(this.path, this.key);
        if (actual !== before && actual !== after) {
            this.conflicted = true;
            const error = new FSError('ECONFLICT', 'Remote conversation recovery conflicts with another writer');
            this.log('reconcile-write', started, this.record, error); throw error;
        }
        this.raw = actual;
        this.record = actual ? JSON.parse(actual) : {};
        this.uncertainWrite = undefined;
        this.log('reconcile-write', started, this.record);
    }
    private log(stage: string, started: number, record: RemoteConversationRecovery, error?: unknown): void {
        const raw = (error as {code?: unknown})?.code;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'JOURNAL_WRITE_UNCONFIRMED';
        const fields = {operation: 'harness.journal', stage, result: error ? 'unconfirmed' : 'confirmed',
            operationId: record.pending?.requestId ?? record.controls?.at(-1)?.requestId ?? record.submission?.id,
            durationMs: Date.now() - started, code: error ? code : undefined};
        if (error) console.warn('[Harness] Recovery write', fields); else console.info('[Harness] Recovery write', fields);
    }
}

function validateSubmissions(record: RemoteConversationRecovery): void {
    if (record.pending?.consumeDraft !== undefined && record.pending.consumeDraft !== false) throw new FSError('EINVAL', 'Invalid native draft consumption');
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
        const query = result.query;
        if (query !== undefined && (!query || typeof query.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(query.id)
            || typeof query.name !== 'string' || !/^[\p{L}\p{N}_:.-]{1,128}$/u.test(query.name)
            || typeof query.sessionId !== 'string' || !query.sessionId || query.sessionId.length > 1024
            || [query.definitionId, query.revision].some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 256))
            || result.commandId !== query.id || result.turnId || result.status !== 'completed')) throw new FSError('EINVAL', 'Invalid query report');
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

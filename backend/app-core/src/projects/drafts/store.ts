import { emptyDraft, decodeDraftRecord } from './record-codec';
import { generateUUID } from '@itookit/common';
import { FSError, type IFileSystem } from '@itookit/vfs-core';

import type { ProjectDraftRecord, ProjectDraftPromotion } from './contracts';

/** The current draft and promotion receipt change atomically; cursors never follow a successor. */
export class ProjectDraftStore {
    private raw: string | null = null;
    private tail: Promise<unknown> = Promise.resolve();
    private record = emptyDraft();
    private beginning?: Promise<ProjectDraftRecord>;
    private readonly path: string;
    constructor(private readonly fs: IFileSystem, readonly projectId: string) {
        if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new FSError('EINVAL', 'Invalid project identity');
        this.path = `/var/lib/projects/${projectId}/draft.seq`;
    }
    async load(): Promise<ProjectDraftRecord> {
        await this.ensureFile();
        await this.fs.meta.seq!.transaction!(async tx => {
            this.raw = await tx.getEntry(this.path, 'draft');
            const decoded = decodeDraftRecord(this.raw);
            this.record = decoded.record;
            if (decoded.migrated) {
                this.raw = JSON.stringify(this.record);
                await tx.setEntry(this.path, 'draft', this.raw);
            }
        });
        await this.collectRetiredAttachments();
        return { ...this.record };
    }
    putAttachment(content: ArrayBuffer): Promise<string> {
        return this.enqueue(async () => {
            const draftId = this.record.id, id = generateUUID(), parentPath = this.attachmentDirectory(draftId);
            await this.assertCurrentDraft(draftId);
            await this.fs.driver.createFile({ parentPath, name: id, content, recursive: true });
            try { await this.assertCurrentDraft(draftId); }
            catch (error) { await this.removeAttachments(draftId); throw error; }
            return id;
        });
    }
    readAttachment(id: string): Promise<ArrayBuffer> {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new FSError('EINVAL', 'Invalid attachment identity');
        return this.fs.driver.readContent(`${this.attachmentDirectory(this.record.id)}/${id}`, { encoding: 'binary' });
    }
    private attachmentDirectory(draftId: string): string {
        return `/var/lib/projects/${this.projectId}/draft-attachments/${draftId}`;
    }
    private async assertCurrentDraft(id: string): Promise<void> {
        const raw = await this.fs.meta.seq!.getEntry(this.path, 'draft');
        if (decodeDraftRecord(raw).record.id !== id) throw conflict();
    }
    private async removeAttachments(id: string): Promise<void> {
        try { await this.fs.driver.delete([this.attachmentDirectory(id)], { recursive: true }); }
        catch (error) {
            if (!(error instanceof FSError) || error.code !== 'ENOENT') console.warn('Draft attachment cleanup failed', error);
        }
    }
    private async collectRetiredAttachments(): Promise<void> {
        const root = `/var/lib/projects/${this.projectId}/draft-attachments`;
        try {
            if (!await this.fs.driver.exists(root)) return;
            for (const entry of await this.fs.driver.getChildren(root)) {
                if (entry.type !== 'directory' || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
                const raw = await this.fs.meta.seq!.getEntry(this.path, 'draft');
                if (decodeDraftRecord(raw).record.id !== entry.name) await this.removeAttachments(entry.name);
            }
        } catch (error) { console.warn('Retired draft attachment sweep failed', error); }
    }
    saveData(data: string): Promise<void> { return this.save({ data }); }
    reset(): Promise<void> { return this.save(null); }
    private save(patch: Partial<ProjectDraftRecord> | null): Promise<void> {
        return this.enqueue(async () => {
            const oldId = this.record.id;
            const record = patch === null ? emptyDraft() : { ...this.record, ...patch };
            const raw = JSON.stringify(record);
            await this.fs.meta.seq!.transaction!(async tx => {
                if (!await tx.compareAndSet(this.path, 'draft', { expected: this.raw, value: raw })) throw conflict();
            });
            this.raw = raw; this.record = record;
            if (patch === null) { this.beginning = undefined; await this.removeAttachments(oldId); }
        });
    }
    begin(title: string): Promise<ProjectDraftRecord> {
        return this.beginning ??= this.beginNow(title).catch(error => { this.beginning = undefined; throw error; });
    }
    private async beginNow(title: string): Promise<ProjectDraftRecord> {
        if (this.record.state !== 'submitting') await this.save({ state: 'submitting',
            sessionId: generateUUID(), submissionId: generateUUID(), title });
        return { ...this.record };
    }
    /** Caller must first verify the exact persisted Round and its execution reference. */
    promote(): Promise<ProjectDraftPromotion | undefined> {
        return this.enqueue(async () => {
            const old = this.record;
            if (!old.sessionId || !old.submissionId || old.state !== 'submitting') return;
            const next = emptyDraft();
            const event: ProjectDraftPromotion = { type: 'project.draftPromoted', projectId: this.projectId,
                draftId: old.id, sessionId: old.sessionId, submissionId: old.submissionId, nextDraftId: next.id, state: 'promoted' };
            const promoted = await this.fs.meta.seq!.transaction!(async tx => {
                if (await tx.getEntry(this.path, `promotion/${old.id}`)) return;
                if (!await tx.compareAndSet(this.path, 'draft', { expected: this.raw, value: JSON.stringify(next) })) throw conflict();
                await tx.setEntry(this.path, `promotion/${old.id}`, JSON.stringify(event));
                return event;
            });
            if (promoted) await this.removeAttachments(old.id);
            return promoted;
        });
    }
    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const work = this.tail.then(action); this.tail = work.catch(() => {}); return work;
    }
    private async ensureFile(): Promise<void> {
        if (await this.fs.driver.exists(this.path)) return;
        try { await this.fs.driver.createFile({ parentPath: this.path.slice(0, -10), name: 'draft.seq', type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
}
function conflict() { return new FSError('ECONFLICT', 'Draft changed in another window; reopen the draft'); }

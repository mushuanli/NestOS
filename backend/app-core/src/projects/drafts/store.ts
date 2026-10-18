import { emptyDraft, decodeDraftRecord } from './record-codec';
import { randomUUID } from '@itookit/common';
import {nativeIdentityKey} from './remote-identity';
import { FSError, type IFileSystem } from '@itookit/vfs-core';

import type { ProjectDraftRecord, ProjectDraftPromotion, RemoteDraftTarget } from './contracts';

/** The current draft and promotion receipt change atomically; cursors never follow a successor. */
export class ProjectDraftStore {
    private raw: string | null = null;
    private tail: Promise<unknown> = Promise.resolve();
    private record = emptyDraft();
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
            const draftId = this.record.id, id = randomUUID(), parentPath = this.attachmentDirectory(draftId);
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
    async wasPromoted(): Promise<boolean> {
        return await this.fs.meta.seq!.getEntry(this.path, `promotion/${this.record.id}`) !== null;
    }
    private save(patch: Partial<ProjectDraftRecord> | null): Promise<void> {
        return this.enqueue(async () => {
            const oldId = this.record.id;
            const record = await this.fs.meta.seq!.transaction!(async tx => {
                const current = await tx.getEntry(this.path, 'draft');
                const base = current === this.raw ? this.record : decodeDraftRecord(current).record;
                // Preparation may add immutable submission metadata without editing the input.
                if (base.id !== oldId || base.data !== this.record.data) throw conflict();
                const next = patch === null ? emptyDraft() : {...base, ...patch};
                if (!await tx.compareAndSet(this.path, 'draft', { expected: current, value: JSON.stringify(next) })) throw conflict();
                return next;
            });
            this.raw = JSON.stringify(record); this.record = record;
            if (patch === null) await this.removeAttachments(oldId);
        });
    }
    begin(title: string, remoteTarget?: RemoteDraftTarget): Promise<ProjectDraftRecord> {
        return this.enqueue(async () => {
            const record = await this.fs.meta.seq!.transaction!(async tx => {
                const raw = await tx.getEntry(this.path, 'draft'), current = decodeDraftRecord(raw).record;
                if (current.id !== this.record.id || current.data !== this.record.data) throw conflict();
                if (current.state === 'submitting') {
                    if (!sameTarget(current.remoteTarget, remoteTarget)) throw conflict();
                    return current;
                }
                const next: ProjectDraftRecord = {...current, state: 'submitting', sessionId: current.id,
                    submissionId: randomUUID(), title, ...(remoteTarget ? {remoteTarget} : {})};
                if (!await tx.compareAndSet(this.path, 'draft', {expected: raw, value: JSON.stringify(next)})) throw conflict();
                return next;
            });
            this.record = record; this.raw = JSON.stringify(record);
            return {...record};
        });
    }
    /** Caller must first verify the exact persisted Round and its execution reference. */
    promote(remote?: ProjectDraftPromotion['remote']): Promise<ProjectDraftPromotion | undefined> {
        return this.enqueue(async () => {
            const old = this.record;
            if (!remote && (!old.sessionId || !old.submissionId || old.state !== 'submitting')) return;
            const next = emptyDraft();
            const event: ProjectDraftPromotion = { type: 'project.draftPromoted', projectId: this.projectId,
                draftId: old.id, sessionId: old.sessionId ?? old.id, submissionId: old.submissionId ?? remote!.turnId, nextDraftId: next.id, state: 'promoted',
                ...(remote ? {remote} : {}) };
            const promoted = await this.fs.meta.seq!.transaction!(async tx => {
                if (await tx.getEntry(this.path, `promotion/${old.id}`)) return;
                if (!await tx.compareAndSet(this.path, 'draft', { expected: this.raw, value: JSON.stringify(next) })) throw conflict();
                await tx.setEntry(this.path, `promotion/${old.id}`, JSON.stringify(event));
                if (remote) await tx.setEntry(this.path, nativeIdentityKey(remote), old.id);
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
function sameTarget(left?: RemoteDraftTarget, right?: RemoteDraftTarget): boolean {
    return (['connectionId', 'serverProjectId', 'principalId', 'profileId'] as const).every(key => left?.[key] === right?.[key]);
}

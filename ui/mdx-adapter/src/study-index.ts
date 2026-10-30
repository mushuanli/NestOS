import type {IFileSystem} from '@itookit/vfs-core';
import type {ScopedPersistenceStore, StudyChange, StudyDocument, StudyEntry} from '@itookit/mdxeditor';
import {extractStudyCards} from '@itookit/mdxeditor';
import {CLOZE_SRS_PATH, CLOZE_DOCUMENT_KEY, clozeDocumentPrefix, parseClozeStorageKey, type ClozeDocumentRecord} from '@itookit/app-contracts';
import {createModuleLogger, randomUUID, sha256HexSync} from '@itookit/common';

export const STUDY_REFRESH_MS = 5 * 60 * 1000;
const log = createModuleLogger('study-index');
const indices = new WeakMap<IFileSystem, TrackedStudyIndex>();
const isDocument = (path: string) => /\.(md|mdx|markdown|mind)$/i.test(path) && !path.split('/').some(part => part.startsWith('.'));
const decode = (raw: string): unknown => {try {return JSON.parse(raw);} catch {throw Object.assign(new Error('Invalid cloze record'), {code: 'CLOZE_INDEX_INVALID'});}};
interface Source extends StudyDocument {version: number; legacy?: unknown}
export function studyIndex(fs: IFileSystem): TrackedStudyIndex {
    let index = indices.get(fs); if (!index) {index = new TrackedStudyIndex(fs); indices.set(fs, index);} return index;
}
export function registerStudyDocument(fs: IFileSystem, path: string): Promise<void> {return studyIndex(fs).update(path, true);}

/** One workspace cache: membership is durable; source bodies remain in memory only. */
export class TrackedStudyIndex {
    private groups = new Map<string, Map<string, unknown>>();
    private sources = new Map<string, Source>();
    private dirty = new Set<string>();
    private active = new Map<string, Set<() => boolean>>();
    private generations = new Map<string, number>();
    private listeners = new Set<(change: StudyChange) => void>();
    private leases = 0;
    private stops: Array<() => void> = [];
    private timer?: ReturnType<typeof setInterval>;
    private loadedAt = 0;
    private loading?: Promise<void>;
    private pending = new Map<string, Promise<void>>();
    private patches = new Map<string, {path: string; key: string; value: unknown; removed: boolean}>();
    constructor(private readonly fs: IFileSystem) {}
    acquire(path?: string, visible: () => boolean = () => true): () => void {
        if (!this.leases++) this.start();
        if (path) {const entries = this.active.get(path) ?? new Set(); entries.add(visible); this.active.set(path, entries);}
        let released = false;
        return () => {
            if (released) return; released = true;
            if (path) {const entries = this.active.get(path); entries?.delete(visible); if (!entries?.size) this.active.delete(path);}
            if (!--this.leases) {this.stops.splice(0).forEach(stop => stop()); clearInterval(this.timer); this.timer = undefined;}
        };
    }
    private isActive(path: string): boolean {return [...this.active.get(path) ?? []].some(visible => visible());}
    watch(listener: (change: StudyChange) => void): () => void {
        const release = this.acquire(); this.listeners.add(listener);
        return () => {this.listeners.delete(listener); release();};
    }
    private emit(change: StudyChange): void {for (const listener of this.listeners) listener(change);}
    private start(): void {
        this.stops.push(this.fs.on('node:updated', event => {
            for (const node of event.payload.nodes) if (isDocument(node.path) && (node.changedFields?.includes('content') || !node.changedFields && event.payload.reason !== 'metadata')) this.changed(node.path);
        }), this.fs.on('node:deleted', event => {for (const root of event.payload.requestedPaths) {
            for (const path of this.groups.keys()) if (path === root || path.startsWith(root + '/')) {this.groups.delete(path); this.sources.delete(path); this.dirty.delete(path);}
            this.emit({type: 'sources'});
        }}));
        for (const type of ['node:renamed', 'node:moved'] as const) this.stops.push(this.fs.on(type, () => {this.loadedAt = 0; this.sources.clear();}));
        this.timer = setInterval(() => {void this.reconcile().catch(error => this.failure('reconcile', error));}, STUDY_REFRESH_MS);
    }
    private changed(path: string): void {
        if (!this.groups.has(path) && !this.active.has(path)) return;
        this.generations.set(path, (this.generations.get(path) ?? 0) + 1);
        this.dirty.add(path);
        if (this.isActive(path)) void this.update(path).catch(error => this.failure('active-update', error));
    }
    private failure(stage: string, error: unknown): void {
        const code = (error as {code?: unknown})?.code;
        log.warn('study.index', {operationId: randomUUID(), stage, result: 'failure', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CLOZE_INDEX_FAILED'});
    }
    async snapshot(force = false): Promise<void> {
        if (!force && this.loadedAt && Date.now() - this.loadedAt < STUDY_REFRESH_MS) return;
        if (this.loading) return this.loading;
        this.loading = this.load().finally(() => {this.loading = undefined;}); return this.loading;
    }
    private async load(): Promise<void> {
        const operationId = randomUUID(), started = Date.now(), groups = new Map<string, Map<string, unknown>>();
        if (this.fs.meta.seq && await this.fs.driver.exists(CLOZE_SRS_PATH)) await this.fs.meta.seq.walkEntries(CLOZE_SRS_PATH, entry => {
            const parsed = parseClozeStorageKey(entry.key); if (!parsed || !isDocument(parsed.path)) return true;
            const values = groups.get(parsed.path) ?? new Map(); values.set(parsed.key, decode(entry.value)); groups.set(parsed.path, values); return true;
        });
        for (const patch of this.patches.values()) {const values = groups.get(patch.path) ?? new Map(); if (patch.removed) values.delete(patch.key); else values.set(patch.key, patch.value); groups.set(patch.path, values);}
        this.patches.clear(); this.groups = groups; this.loadedAt = Date.now();
        log.info('study.index', {operationId, stage: 'snapshot', result: 'success', documents: groups.size, durationMs: Date.now() - started});
    }
    async list(parent = '/'): Promise<StudyEntry[]> {
        while (this.pending.size) await Promise.all(this.pending.values()); await this.snapshot();
        const entries = new Map<string, StudyEntry>(), prefix = parent === '/' ? '/' : parent + '/';
        for (const [path, values] of this.groups) {
            const record = values.get(CLOZE_DOCUMENT_KEY) as ClozeDocumentRecord | undefined;
            if (record?.count === 0 || !path.startsWith(prefix)) continue;
            const suffix = path.slice(prefix.length), slash = suffix.indexOf('/');
            const id = slash < 0 ? path : prefix + suffix.slice(0, slash);
            entries.set(id, {id, title: id.slice(id.lastIndexOf('/') + 1), kind: slash < 0 ? 'document' : 'directory'});
        }
        return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    async read(path: string): Promise<StudyDocument> {
        const node = await this.fs.driver.getNode(path); if (!node || node.type !== 'file') throw Object.assign(new Error('Tracked document missing'), {code: 'ENOENT'});
        const cached = this.sources.get(path); if (cached?.version === node.version) return cached;
        const raw = await this.fs.driver.readContent(path, {encoding: 'utf-8'}), content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const current = await this.fs.driver.getNode(path);
        if (!current || current.version !== node.version) throw Object.assign(new Error('Document changed during indexing'), {code: 'CLOZE_DOCUMENT_CHANGED'});
        const source = {content, revision: sha256HexSync(content), version: node.version, legacy: node.metadata?.['_mdx_plugin_cloze:memory']};
        this.sources.set(path, source); return source;
    }
    update(path: string, activate = false): Promise<void> {
        const previous = this.pending.get(path); if (previous) return previous;
        let success = false;
        const work = this.updateDocument(path, activate).then(() => {success = true;}).finally(() => {
            this.pending.delete(path);
            if (success && this.dirty.has(path) && this.isActive(path)) void this.update(path).catch(error => this.failure('active-update', error));
        }); this.pending.set(path, work); return work;
    }
    private async updateDocument(path: string, activate: boolean): Promise<void> {
        const operationId = randomUUID(), started = Date.now(), generation = this.generations.get(path); await this.snapshot();
        if (!isDocument(path) || !activate && !this.groups.has(path) && !this.active.has(path)) return;
        const source = await this.read(path);
        const previous = this.groups.get(path)?.get(CLOZE_DOCUMENT_KEY) as ClozeDocumentRecord | undefined;
        if (previous?.digest === source.revision) {if (generation === this.generations.get(path)) this.dirty.delete(path); return;}
        const cards = extractStudyCards({id: path, title: '', kind: 'document'}, source);
        if (!cards.length && !this.groups.has(path)) {if (generation === this.generations.get(path)) this.dirty.delete(path); return;}
        const record: ClozeDocumentRecord = {v: 1, count: cards.length, digest: source.revision, updatedAt: Date.now()};
        if (!this.fs.meta.seq) throw Object.assign(new Error('Seqfile unavailable'), {code: 'CLOZE_INDEX_UNAVAILABLE'});
        if (!await this.fs.driver.exists(CLOZE_SRS_PATH)) {
            try {await this.fs.driver.createFile({parentPath: '/.nestos', name: 'cloze-srs.seq', type: 'seqfile', recursive: true});}
            catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
        }
        await this.fs.meta.seq.setEntry(CLOZE_SRS_PATH, clozeDocumentPrefix(path) + CLOZE_DOCUMENT_KEY, JSON.stringify(record));
        this.patch(path, CLOZE_DOCUMENT_KEY, record, false, false);
        if (generation === this.generations.get(path)) this.dirty.delete(path); this.emit({type: 'sources'});
        log.info('study.index', {operationId, stage: 'document', result: 'success', count: cards.length, durationMs: Date.now() - started});
    }
    patch(path: string, key: string, value: unknown, removed = false, notify = true): void {
        const added = !this.groups.has(path);
        if (this.loading) this.patches.set(clozeDocumentPrefix(path) + key, {path, key, value, removed});
        const values = this.groups.get(path) ?? new Map(); if (removed) values.delete(key); else values.set(key, value); this.groups.set(path, values);
        if (notify) this.emit(added ? {type: 'sources'} : {type: 'progress', documents: [path]});
    }
    async reconcile(): Promise<void> {
        await this.snapshot(true);
        for (const path of this.groups.keys()) if (!this.isActive(path)) this.dirty.add(path);
        for (const path of [...this.dirty]) {
            try {await this.update(path);} catch (error) {
                if ((error as {code?: string}).code === 'ENOENT') {this.groups.delete(path); this.sources.delete(path); this.dirty.delete(path); this.emit({type: 'sources'});}
                else this.failure('document-reconcile', error);
            }
        }
        this.emit({type: 'progress'});
    }
    store(path: string, writable: ScopedPersistenceStore): ScopedPersistenceStore {
        return {
            get: async key => {await this.snapshot(); return key === '_mdx_srs' ? (this.sources.get(path)?.legacy as Record<string, unknown>)?.[key] : this.groups.get(path)?.get(key);},
            entries: async (prefix = '') => {await this.snapshot(); return [...this.groups.get(path) ?? []].filter(([key]) => key !== CLOZE_DOCUMENT_KEY && key.startsWith(prefix));},
            set: (key, value) => writable.set(key, value), remove: key => writable.remove(key), destroy: () => writable.destroy?.(),
        };
    }
}

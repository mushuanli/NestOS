import { serializeSessionSummary, indexSessionSummary, navigationPrefix, NAVIGATION_VERSION, NAVIGATION_REVISION } from './session-navigation-index';
import { sessionSettings, mergeSessionSettings } from './session-settings';
import { SessionRelations, assertSessionAvailable, readSessionMetadata, touchSessionRelations } from './session-relations';
import { ulid } from './ulid';
import { createFileSystemView, FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import { DEFAULT_SESSION_SETTINGS, type ChatSessionSettings, type ConversationManifest, type SessionSummary, type ConversationUIState, type ISessionRepository, type SessionFolder, type SessionOrigin, type SessionLoadState, type SessionView, type SessionRepositoryChange } from './types';
import { sessionStorageRoot } from './session-storage-layout';
import { resolveSessionStorageRoot, recoverSessionDataMoves, moveSessionDataDirectory } from './session-storage-locations';
import { reserveSessionStorage, assertSessionStorageLocation, validateProjectSessionStorage } from './session-storage-identity';
import { SessionStorageTrace } from './session-storage-trace';
import type { SessionLogger } from '../utils/host-ports';
import { collectHistoryChain, readRoundDocument, type SessionHistoryChain } from './history-chain';
import type { PersistedRound, RoundManifest } from './round-types';

const FOLDERS_PATH = '/var/lib/sessions/folders.seq';
const FOLDERS_KEY = 'folders';

interface SessionPaths { root: string; session: string; history: string }

/** Session identity, history and attachments. No document path is a Session identity. */
export class SessionRepository implements ISessionRepository {
    private readonly listeners = new Set<(change?: SessionRepositoryChange) => void>();
    private closed = false;
    private structuralWriteGuard?: (ids: string[]) => Promise<void>;
    async assertStructuralWritable(ids: string[]): Promise<void> { await this.structuralWriteGuard?.(ids); }
    setStructuralWriteGuard(guard: (ids: string[]) => Promise<void>): void { this.structuralWriteGuard = guard; }
    private get relations() { return new SessionRelations(this.fs, () => this.list(), this.structuralWriteGuard); }
    constructor(private readonly fs: IFileSystem,
        private readonly initializeNewSession?: (sessionId: string) => Promise<void>, private readonly logger?: SessionLogger) {}
    setStorageDirectoryResolver(resolver: (folder: string | null) => Promise<string | undefined>): void { this.storageDirectory = resolver; }
    private storageDirectory?: (folder: string | null) => Promise<string | undefined>;
    private initialization?: Promise<void>;
    init(): Promise<void> {
        if (this.closed) return Promise.reject(new FSError('EACCES', 'Session repository is closed'));
        return this.initialization ??= this.initialize();
    }
    private async initialize(): Promise<void> {
        if (!this.fs.meta.seq?.transaction) throw new Error('Session storage requires record transactions');
        await recoverSessionDataMoves(this.fs, this.logger);
        await this.ensureFolderRecord();
        const navigationVersion = await this.fs.meta.seq!.getEntry(FOLDERS_PATH, NAVIGATION_VERSION);
        await this.ensureNavigationIndex(navigationVersion);
    }
    async dispose(): Promise<void> {
        this.closed = true;
        await this.initialization?.catch(() => {});
        this.listeners.clear();
    }
    subscribe(listener: (change?: SessionRepositoryChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private notify(change: SessionRepositoryChange = { kind: 'session' }) { for (const listener of this.listeners) listener(change); }
    private root(id: string) { if (this.closed) throw new FSError('EACCES', 'Session repository is closed'); return resolveSessionStorageRoot(this.fs.meta.seq!, id); }
    private name(name: string): string {
        if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') throw new FSError('EINVAL', 'Invalid Session data name');
        return name;
    }
    private async paths(id: string, reader: Pick<ISeqFileTransaction, 'getEntry'> = this.fs.meta.seq!): Promise<SessionPaths> { const root = await resolveSessionStorageRoot(reader, id); return { root, session: `${root}/session.seq`, history: `${root}/history.seq` }; }
    async createSession(title: string, folder: string | null = null, parentSessionId: string | null = null, initialState?: ConversationUIState, creation?: import('./types').SessionCreation): Promise<string> {
        return this.initializeSession(`node-${ulid()}`, title, 'tauri', folder, parentSessionId, true, structuredClone(initialState), creation?.agentId, structuredClone(creation?.initialContext));
    }
    async indexProjectSessions(directory: string): Promise<void> {
        await new SessionStorageTrace('session.storage.index', { directory }, this.logger)
            .run(trace => this.indexProjectDirectory(directory, trace));
    }
    private async indexProjectDirectory(directory: string, trace: SessionStorageTrace): Promise<void> {
        if (!await this.fs.driver.exists(directory)) return;
        const children = await trace.step('scan-directory', () => this.fs.driver.getChildren(directory));
        await this.ensureFolderRecord();
        const directories = children.filter(child => child.type === 'directory');
        await trace.step('index-transaction', () => this.fs.meta.seq!.transaction!(async tx => {
            const rows = await tx.getEntriesMany(directories.map(child => ({ fileIdOrPath: `${child.path}/session.seq`, key: 'session' })));
            const sessions = rows.map(raw => raw ? JSON.parse(raw) as SessionSummary : null);
            const keys = directories.flatMap((child, index) => {
                const session = sessions[index];
                return [`storage/${child.name}`, `moving/${child.name}`, ...(session ? [navigationPrefix(session.folder ?? null) + session.id, `navigation-location/${session.id}`] : [])];
            });
            const stored = await tx.getEntries(FOLDERS_PATH, keys);
            await trace.step('validate-identities', () => validateProjectSessionStorage(tx, directories, sessions, stored));
            for (const [index, child] of directories.entries()) {
                const raw = rows[index]; if (!raw) continue;
                const previous = stored[`storage/${child.name}`];
                if (!previous) await tx.setEntry(FOLDERS_PATH, `storage/${child.name}`, child.path);
                const session = sessions[index]!;
                const key = navigationPrefix(session.folder ?? null) + session.id;
                if (stored[key] !== serializeSessionSummary(session) || stored[`navigation-location/${session.id}`] !== key)
                    await indexSessionSummary(tx, session);
            }
        }));
    }
    async validateProjectSessions(directory: string): Promise<void> {
        await new SessionStorageTrace('session.storage.validate', { directory }, this.logger)
            .run(trace => trace.step('scan-and-validate', () => this.validateProjectDirectory(directory)));
    }
    private async validateProjectDirectory(directory: string): Promise<void> {
        if (!await this.fs.driver.exists(directory)) return;
        const children = (await this.fs.driver.getChildren(directory)).filter(child => child.type === 'directory');
        await this.fs.meta.seq!.transaction!(async tx => {
            const rows = await tx.getEntriesMany(children.map(child => ({ fileIdOrPath: `${child.path}/session.seq`, key: 'session' })));
            await validateProjectSessionStorage(tx, children, rows.map(raw => raw ? JSON.parse(raw) : null));
        });
    }
    private async prepareStorage(id: string, folder: string | null, createOnly: boolean): Promise<void> {
        await this.ensureFolderRecord();
        const directory = await this.storageDirectory?.(folder);
        await reserveSessionStorage(this.fs, id, directory ? `${directory}/${id}` : sessionStorageRoot(id), createOnly);
    }
    async relocateProjectStorage(id: string): Promise<void> {
        if (!this.storageDirectory) return;
        const session = await this.getManifest(id), directory = await this.storageDirectory(session.folder ?? null);
        if (!directory) return;
        const from = await this.root(id), to = `${directory}/${id}`;
        if (from !== to) await moveSessionDataDirectory(this.fs, from, to, this.logger);
    }
    /** Idempotently create a Session with a host-supplied durable identity. */
    async ensureSession(id: string, title: string, origin: SessionOrigin = 'tauri', folder: string | null = null, parentSessionId: string | null = null,
        creation?: import('./types').SessionCreation): Promise<string> {
        return this.initializeSession(id, title, origin, folder, parentSessionId, false, undefined, creation?.agentId, structuredClone(creation?.initialContext));
    }
    private async initializeSession(id: string, title: string, origin: SessionOrigin, folder: string | null,
        parentSessionId: string | null, createOnly: boolean, initialState?: ConversationUIState, createdWithAgentId?: string, initialContext?: import('../contracts/content-transfer').ContentTransfer): Promise<string> {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new FSError('EINVAL', 'Invalid Session identity');
        await this.structuralWriteGuard?.([id, ...(parentSessionId ? [parentSessionId] : [])]);
        await this.prepareStorage(id, folder, createOnly);
        const p = await this.paths(id);
        const normalizedFolder = normalizeFolderPath(folder);
        const now = Date.now();
        const existed = await this.fs.driver.exists(p.session);
        let repaired = await this.ensureSessionFiles(p);
        await this.ensureFolderRecord();
        try {
            if (await this.fs.meta.seq!.transaction!(tx => this.initializeSessionTx(tx, p, { id, title, origin, folder: normalizedFolder, parentSessionId, now, createOnly, initialState, createdWithAgentId, initialContext }))) {
                repaired = true;
            }
            if (!existed) await this.initializeNewSession?.(id);
        } catch (error) {
            // Preserve committed identities and concurrent creators; incomplete files can be recovered.
            if (!existed && !await this.fs.meta.seq!.getEntry(p.session, 'session'))
                await this.fs.driver.delete([p.root], { recursive: true }).catch(() => undefined);
            throw error;
        }
        if (repaired) this.notify();
        return id;
    }
    /** Create missing seq files; a fresh file must start empty (records outlive files). */
    private async ensureSessionFiles(p: SessionPaths): Promise<boolean> {
        let repaired = false;
        for (const [path, name] of [[p.session, 'session.seq'], [p.history, 'history.seq']] as const) {
            if (await this.fs.driver.exists(path)) continue;
            await this.fs.driver.createFile({ name, parentPath: p.root, type: 'seqfile', recursive: true });
            await this.clearEntries([path]);
            repaired = true;
        }
        if (!await this.fs.driver.exists(`${p.root}/attachments`)) {
            await this.fs.driver.createDirectory({ name: 'attachments', parentPath: p.root });
            repaired = true;
        }
        return repaired;
    }
    /** Returns whether anything had to be repaired (session, settings or history). */
    private async initializeSessionTx(tx: ISeqFileTransaction, p: SessionPaths, init: {
        id: string; title: string; origin: SessionOrigin; folder: string | null; parentSessionId: string | null; now: number; createOnly: boolean; initialState?: ConversationUIState; createdWithAgentId?: string; initialContext?: import('../contracts/content-transfer').ContentTransfer;
    }): Promise<boolean> {
        await assertSessionAvailable(tx, init.id);
        await assertSessionStorageLocation(tx, init.id, p.root);
        let repaired = false;
        const rawSession = await tx.getEntry(p.session, 'session');
        if (rawSession) {
            if (init.createOnly) throw new FSError('EEXIST', `Session identity already exists: ${init.id}`, 'create', p.root);
            const session = JSON.parse(rawSession);
            if (session.storageVersion !== 1 || session.id !== init.id) throw new Error('Session storage version incompatible');
        } else {
            if (init.parentSessionId) {
                await assertSessionAvailable(tx, init.parentSessionId);
                const parent = await readSessionMetadata(tx, init.parentSessionId);
                init.folder = parent.folder ?? null;
            }
            // A new Session must land in an existing folder; otherwise it would be
            // invisible in every listing without any way to reach it.
            if (init.folder && !(await this.readFolderEntries(tx)).some(item => item.path === init.folder)) {
                throw new FSError('ENOENT', 'Session folder not found');
            }
            const record = { storageVersion: 1, id: init.id, title: init.title, origin: init.origin, folder: init.folder, parentSessionId: init.parentSessionId,
                createdAt: init.now, updatedAt: init.now, revision: 0, ...(init.createdWithAgentId ? {createdWithAgentId: init.createdWithAgentId} : {}), ...(init.initialState ? { uiState: init.initialState } : {}), ...(init.initialContext ? { initialContext: init.initialContext } : {}) };
            await tx.setEntry(p.session, 'session', JSON.stringify(record));
            await indexSessionSummary(tx, record, null);
            await touchSessionRelations(tx);
            repaired = true;
        }
        if (!await tx.getEntry(p.session, 'settings')) {
            await tx.setEntry(p.session, 'settings', JSON.stringify(DEFAULT_SESSION_SETTINGS));
            repaired = true;
        }
        const rawHistory = await tx.getEntry(p.history, 'index');
        if (rawHistory) {
            const history = JSON.parse(rawHistory);
            if (history?.schemaVersion !== 3) throw new Error('Session history version incompatible');
        } else {
            await tx.setEntry(p.history, 'index', JSON.stringify({ schemaVersion: 3, rootRoundId: null, branches: { main: null }, branchMeta: {}, currentBranch: 'main', currentHead: null, children: {} }));
            repaired = true;
        }
        return repaired;
    }
    async getManifest(id: string): Promise<ConversationManifest> {
        return this.fs.meta.seq!.transaction!(async tx => this.readManifestTx(tx, await this.paths(id, tx), id));
    }
    async getLoadState(id: string): Promise<SessionLoadState> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx);
            const rows = await tx.getEntries(p.session, ['session', 'settings']);
            const manifest = await this.readManifestTx(tx, p, id, rows.session ?? null);
            return { manifest, settings: sessionSettings(rows.settings, manifest) };
        });
    }
    /**
     * Projection plus history chain for one editor load. The editor needs both, and reading them
     * together keeps one storage snapshot (one sidecar transaction, one journal probe) per bind.
     */
    async loadView(id: string): Promise<SessionView> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx);
            const rows = await tx.getEntries(p.session, ['session', 'settings']);
            const manifest = await this.readManifestTx(tx, p, id, rows.session ?? null);
            const chain = await this.readIndexedHistoryChain(tx, p, manifest)
                ?? await collectHistoryChain(manifest, roundId => this.readRound(tx, p, roundId, manifest));
            return {
                manifest,
                settings: sessionSettings(rows.settings, manifest),
                chain,
            };
        });
    }
    async readHistoryChain(id: string): Promise<SessionHistoryChain> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx);
            const manifest = await this.readManifestTx(tx, p, id);
            return await this.readIndexedHistoryChain(tx, p, manifest)
                ?? collectHistoryChain(manifest, roundId => this.readRound(tx, p, roundId, manifest));
        });
    }
    private async readIndexedHistoryChain(tx: ISeqFileTransaction, p: SessionPaths,
        manifest: ConversationManifest): Promise<SessionHistoryChain | null> {
        const candidates = indexedHistoryCandidates(manifest);
        if (!candidates) return null;
        const overrides = manifest.branchMeta[manifest.currentBranch]?.roundOverrides;
        const keys = candidates.map(id => `document/${this.name(`round-${overrides?.[id] ?? id}.json`)}`);
        const rows = await tx.getEntries(p.history, keys);
        const parsed = await Promise.all(keys.map(async (key, index) => {
            const round = await readRoundDocument(async () => rows[key] ?? null);
            return round && overrides?.[candidates[index]] ? {...round, id: candidates[index]} : round;
        }));
        if (!historyIndexMatches(candidates, parsed)) return null;
        const byId = new Map(candidates.map((id, index) => [id, parsed[index]]));
        return collectHistoryChain(manifest, async roundId => byId.get(roundId) ?? null);
    }
    private async readRound(tx: ISeqFileTransaction, p: SessionPaths, roundId: string, manifest: ConversationManifest) {
        const documentId = manifest.branchMeta[manifest.currentBranch]?.roundOverrides?.[roundId] ?? roundId;
        const round = await readRoundDocument(() => tx.getEntry(
            p.history, `document/${this.name(`round-${documentId}.json`)}`,
        ));
        return round && documentId !== roundId ? {...round, id: roundId} : round;
    }
    private async readManifestTx(tx: ISeqFileTransaction, p: SessionPaths, id: string,
        sessionValue?: string | null): Promise<ConversationManifest> {
        const raw = sessionValue === undefined ? await tx.getEntry(p.session, 'session') : sessionValue;
        if (!raw) throw new FSError('ENOENT', `Session not found: ${id}`);
        const session = JSON.parse(raw);
        if (session.storageVersion !== 1 || session.id !== id) throw new Error('Session storage version incompatible');
        const rawHistory = await tx.getEntry(p.history, 'index');
        if (!rawHistory) throw new FSError('ENOENT', `Session history not found: ${id}`);
        const history = JSON.parse(rawHistory);
        if (history?.schemaVersion !== 3) throw new Error('Session history version incompatible');
        return { ...session, ...history };
    }
    async pendingStorageSessionIds(): Promise<Set<string>> {
        const ids = new Set<string>();
        if (await this.fs.driver.exists(FOLDERS_PATH)) await this.fs.meta.seq!.walkEntries(FOLDERS_PATH,
            entry => { ids.add(entry.key.slice(7)); return true; }, { keyPrefix: 'moving/' });
        return ids;
    }
    private async ensureNavigationIndex(version: string | null): Promise<void> {
        if (version === '1') return;
        for (let attempt = 0; attempt < 3; attempt++) {
            const revision = await this.fs.meta.seq!.getEntry(FOLDERS_PATH, NAVIGATION_REVISION);
            const summaries = await this.scanSummaries(true);
            const indexed = await this.fs.meta.seq!.transaction!(async tx => {
                if (await tx.getEntry(FOLDERS_PATH, NAVIGATION_REVISION) !== revision) return false;
                for (const summary of summaries) await indexSessionSummary(tx, summary);
                await tx.setEntry(FOLDERS_PATH, NAVIGATION_VERSION, '1');
                return true;
            });
            if (indexed) return;
        }
        throw new FSError('EBUSY', 'Session navigation changed during indexing');
    }
    async listSummariesInFolder(folder: string | null): Promise<SessionSummary[]> {
        if (this.closed) throw new FSError('EACCES', 'Session repository is closed');
        const normalized = normalizeFolderPath(folder);
        if (await this.fs.meta.seq!.getEntry(FOLDERS_PATH, NAVIGATION_VERSION) !== '1')
            return (await this.listSummaries()).filter(session => (session.folder ?? null) === normalized);
        const rows: SessionSummary[] = [];
        await this.fs.meta.seq!.walkEntries(FOLDERS_PATH, entry => { rows.push(JSON.parse(entry.value)); return true; },
            { keyPrefix: navigationPrefix(normalized) });
        const moving = await this.pendingStorageSessionIds();
        return rows.filter(row => !moving.has(row.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    listSummaries(): Promise<SessionSummary[]> { return this.scanSummaries(); }
    private async scanSummaries(includeMoving = false): Promise<SessionSummary[]> {
        if (this.closed) throw new FSError('EACCES', 'Session repository is closed');
        if (!await this.fs.driver.exists('/var/lib/sessions')) return [];
        const entries = await this.fs.driver.getChildren('/var/lib/sessions', { fields: 'entry' });
        const ids = entries.flatMap(entry => entry.type === 'directory' ? [entry.name] : []);
        const locations = new Map<string, string>();
        if (await this.fs.driver.exists(FOLDERS_PATH)) await this.fs.meta.seq!.walkEntries(FOLDERS_PATH, entry => { const id = entry.key.slice(8); ids.push(id); locations.set(id, entry.value); return true; }, { keyPrefix: 'storage/' });
        const pending = await this.pendingStorageSessionIds();
        const uniqueIds = [...new Set(ids)].filter(id => includeMoving || !pending.has(id));
        const summaries: SessionSummary[] = [];
        for (let start = 0; start < uniqueIds.length; start += 64) {
            const batch = uniqueIds.slice(start, start + 64);
            const rows = await this.fs.meta.seq!.getEntriesMany(batch.map(id => ({
                fileIdOrPath: `${locations.get(id) ?? sessionStorageRoot(id)}/session.seq`, key: 'session',
            })));
            rows.forEach((raw, index) => {
                if (raw === null) return;
                const session = JSON.parse(raw);
                if (session.storageVersion !== 1 || session.id !== batch[index]) throw new Error('Session storage version incompatible');
                const { id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId } = session;
                summaries.push({ id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId });
            });
        }
        return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async list(): Promise<ConversationManifest[]> {
        if (this.closed) throw new FSError('EACCES', 'Session repository is closed');
        if (!await this.fs.driver.exists('/var/lib/sessions')) return [];
        const candidates: Array<{ id: string; path: string }> = [];
        for (const node of await this.fs.driver.getChildren('/var/lib/sessions', { fields: 'entry' })) {
            if (node.type === 'directory') candidates.push({ id: node.name, path: node.path });
        }
        if (await this.fs.driver.exists(FOLDERS_PATH)) await this.fs.meta.seq!.walkEntries(FOLDERS_PATH, entry => {
            const id = entry.key.slice(8); if (!candidates.some(item => item.id === id)) candidates.push({ id, path: entry.value }); return true;
        }, { keyPrefix: 'storage/' });
        const pending = await this.pendingStorageSessionIds();
        const available = candidates.filter(item => !pending.has(item.id));
        const result: ConversationManifest[] = [];
        // Bound transaction duration without opening a transaction for every Session.
        for (let start = 0; start < available.length; start += 64) {
            const batch = available.slice(start, start + 64);
            const present = await Promise.all(batch.map(async ({ id, path }) =>
                await this.fs.driver.exists(`${path}/session.seq`) ? id : null));
            result.push(...await this.readManifestBatch(present.filter((id): id is string => id !== null)));
        }
        return result.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    private readManifestBatch(ids: string[]): Promise<ConversationManifest[]> {
        return this.fs.meta.seq!.transaction!(async tx => {
            // Drain every read before the transaction commits or rolls back.
            const reads = await Promise.allSettled(ids.map(async id => this.readManifestTx(tx, await this.paths(id, tx), id)));
            const result: ConversationManifest[] = [];
            for (const read of reads) {
                if (read.status === 'fulfilled') result.push(read.value);
                // Interrupted creation can leave incomplete records until repair.
                else if (!(read.reason instanceof FSError && read.reason.code === 'ENOENT')) throw read.reason;
            }
            return result;
        });
    }
    async deleteSession(id: string): Promise<void> {
        const root = await this.root(id);
        const p = await this.paths(id);
        await this.prepareSessionDeletion(id);
        // Physical storage goes first. Clearing records before a delete that can
        // still fail (fixed Kernel layout, host permissions) loses the Session
        // while leaving its directory behind, which is unrecoverable.
        if (await this.fs.driver.exists(root)) await this.fs.driver.delete([root], { recursive: true });
        // Deleting files does not purge SeqFile records, and stale records would
        // resurrect the Session if its identity is ever reused.
        await this.clearEntries([p.session, p.history]);
        await this.fs.meta.seq!.deleteEntry(FOLDERS_PATH, `storage/${id}`);
        await this.relations.finishDeletion(id);
        this.notify();
    }
    async prepareSessionDeletion(id: string): Promise<void> {
        await this.ensureFolderRecord();
        await this.relations.prepareDeletion(id); this.notify();
    }
    async isSessionDeletionPending(id: string): Promise<boolean> {
        if (!await this.fs.driver.exists(FOLDERS_PATH)) return false;
        return !!await this.fs.meta.seq!.getEntry(FOLDERS_PATH, `deleting/${id}`);
    }
    pendingSessionDeletions(): Promise<Array<{ id: string }>> { return this.relations.pending(); }
    async listFolders(): Promise<SessionFolder[]> {
        return (await this.readFolders()).sort((a, b) => a.path.localeCompare(b.path));
    }
    async createFolder(path: string, project?: SessionFolder['project']): Promise<SessionFolder> {
        const normalized = normalizeFolderPath(path);
        if (!normalized) throw new FSError('EINVAL', 'Invalid Session folder path');
        if (project) this.validateProject(project);
        const folder = await this.mutateFolders(folders => {
            const existing = folders.find(item => item.path === normalized);
            if (existing) {
                if (project && existing.project?.id !== project.id) throw new FSError('EEXIST', 'Project folder already exists');
                return { folders, result: existing };
            }
            const parentPath = folderParent(normalized);
            if (parentPath && !folders.some(item => item.path === parentPath)) throw new FSError('ENOENT', 'Parent Session folder not found');
            const created: SessionFolder = { path: normalized, name: normalized.slice(normalized.lastIndexOf('/') + 1), parentPath, updatedAt: Date.now(),
                ...(project ? { project: { ...project } } : {}) };
            return { folders: [...folders, created], result: created };
        });
        this.notify();
        return folder;
    }
    async promoteProjectFolder(path: string, project: NonNullable<SessionFolder['project']>): Promise<void> {
        this.validateProject(project);
        await this.mutateFolders(folders => {
            const folder = folders.find(item => item.path === normalizeFolderPath(path));
            if (!folder) throw new FSError('ENOENT', 'Session folder not found');
            if (folder.project && folder.project.id !== project.id) throw new FSError('ECONFLICT', 'Project folder identity changed');
            return { folders: folders.map(item => item === folder ? { ...item, project: structuredClone(project), updatedAt: Date.now() } : item), result: undefined };
        });
        this.notify();
    }
    async replaceProjectReference(path: string, expected: NonNullable<SessionFolder['project']>, next: NonNullable<SessionFolder['project']>): Promise<void> {
        this.validateProject(next);
        if (expected.id !== next.id) throw new FSError('EINVAL', 'Project identity cannot change');
        await this.mutateFolders(folders => {
            const folder = folders.find(item => item.path === normalizeFolderPath(path));
            if (!folder) throw new FSError('ENOENT', 'Project folder not found');
            if (JSON.stringify(folder.project) !== JSON.stringify(expected)) throw new FSError('ECONFLICT', 'Project source changed');
            return { folders: folders.map(item => item === folder ? { ...item, project: structuredClone(next), updatedAt: Date.now() } : item), result: undefined };
        });
        this.notify();
    }
    private validateProject(project: NonNullable<SessionFolder['project']>): void {
        if (!/^[a-zA-Z0-9_-]+$/.test(project.id) || !project.directory) throw new FSError('EINVAL', 'Invalid project reference');
        if (project.source && (!['local', 'remote'].includes(project.source.kind)
            || project.source.kind === 'remote' && project.directory !== `project:${project.id}`)) throw new FSError('EINVAL', 'Invalid project source');
    }
    async deleteFolder(path: string, recursive = false): Promise<void> {
        const normalized = normalizeFolderPath(path);
        if (!normalized) throw new FSError('EINVAL', 'Invalid Session folder path');
        const folders = await this.readFolders();
        if (!folders.some(folder => folder.path === normalized)) throw new FSError('ENOENT', 'Session folder not found');
        const sessions = (await this.list()).filter(session => session.folder === normalized || session.folder?.startsWith(`${normalized}/`));
        const hasChildren = folders.some(folder => folder.parentPath === normalized);
        if ((hasChildren || sessions.length) && !recursive) throw new FSError('ENOTEMPTY', 'Session folder is not empty');
        if (recursive) for (const session of sessions) await this.deleteSession(session.id);
        await this.mutateFolders(current => ({
            folders: current.filter(folder => folder.path !== normalized && !folder.path.startsWith(`${normalized}/`)),
            result: undefined,
        }));
        this.notify();
    }
    async renameFolder(from: string, to: string): Promise<void> {
        const source = normalizeFolderPath(from), target = normalizeFolderPath(to);
        if (!source || !target) throw new FSError('EINVAL', 'Invalid Session folder path');
        const folders = await this.readFolders();
        if (!folders.some(folder => folder.path === source)) throw new FSError('ENOENT', 'Session folder not found');
        if (folders.some(folder => folder.path === target)) throw new FSError('EEXIST', 'Session folder already exists');
        if (target.startsWith(`${source}/`)) throw new FSError('EINVAL', 'Cannot move a Session folder into itself');
        const parentPath = folderParent(target);
        if (parentPath && !folders.some(folder => folder.path === parentPath)) throw new FSError('ENOENT', 'Parent Session folder not found');
        const now = Date.now();
        const relationRevision = await this.fs.meta.seq!.getEntry(FOLDERS_PATH, 'relations-revision');
        const owned = (await this.list()).filter(session => session.folder === source || session.folder?.startsWith(`${source}/`));
        await this.ensureFolderRecord();
        await this.structuralWriteGuard?.(owned.map(item => item.id));
        // Folder records and every affected Session ownership change commit together,
        // so a failure can never leave Sessions pointing at a folder that is gone.
        await this.fs.meta.seq!.transaction!(async tx => {
            if (await tx.getEntry(FOLDERS_PATH, 'relations-revision') !== relationRevision) throw new FSError('EBUSY', 'Session hierarchy changed; retry the folder move');
            const current = await this.readFolderEntries(tx);
            if (!current.some(folder => folder.path === source)) throw new FSError('ENOENT', 'Session folder not found');
            if (current.some(folder => folder.path === target)) throw new FSError('EEXIST', 'Session folder already exists');
            await tx.setEntry(FOLDERS_PATH, FOLDERS_KEY, JSON.stringify(current.map(folder => {
                if (folder.path === source) return { ...folder, path: target, name: target.slice(target.lastIndexOf('/') + 1), parentPath, updatedAt: now };
                if (folder.path.startsWith(`${source}/`)) {
                    const path = target + folder.path.slice(source.length);
                    return { ...folder, path, parentPath: folderParent(path), updatedAt: now };
                }
                return folder;
            })));
            await touchSessionRelations(tx);
            for (const session of owned) {
                await assertSessionAvailable(tx, session.id);
                const folder = session.folder === source ? target : target + (session.folder ?? '').slice(source.length);
                await this.writeManifestTx(tx, await this.paths(session.id, tx), { folder });
            }
        });
        this.notify();
    }
    /** Recovery holds explicit leases; use its validator without recursively entering the write gate. */
    async reconcileFolder(id: string, folder: string, ensureLeases: (ids: string[]) => Promise<void>): Promise<void> {
        await this.ensureFolderRecord();
        const relations = new SessionRelations(this.fs, () => this.list(), ensureLeases);
        await relations.move(id, undefined, normalizeFolderPath(folder));
        this.notify();
    }
    async updateManifest(id: string, patch: Partial<ConversationManifest>): Promise<void> {
        if (patch.id && patch.id !== id) throw new FSError('EINVAL', 'Session identity cannot change');
        if (patch.folder !== undefined || patch.parentSessionId !== undefined) {
            await this.ensureFolderRecord();
            await this.relations.move(id, patch.parentSessionId, patch.folder === undefined ? undefined : normalizeFolderPath(patch.folder));
            const { folder: _folder, parentSessionId: _parent, ...rest } = patch;
            patch = rest; this.notify();
        }
        const changed = await this.fs.meta.seq!.transaction!(async tx => this.writeManifestTx(tx, await this.paths(id, tx), patch));
        if (changed) this.notify({ sessionId: id, kind: Object.keys(patch).every(key => key === 'uiState') ? 'ui-state' : 'session' });
    }
    private async writeManifestTx(tx: ISeqFileTransaction, p: SessionPaths, patch: Partial<ConversationManifest>): Promise<boolean> {
        const raw = await tx.getEntry(p.session, 'session');
        if (!raw) throw new FSError('ENOENT', 'Session not found');
        const current = JSON.parse(raw);
        if (current.storageVersion !== 1) throw new Error('Session storage version incompatible');
        const { id: _id, title, summary, origin, folder, parentSessionId: _parent, uiState, flow, initialContext, createdWithAgentId, createdAt: _created, updatedAt: _updated, ...historyPatch } = patch;
        if ('initialContext' in patch && JSON.stringify(initialContext) !== JSON.stringify(current.initialContext))
            throw new FSError('EINVAL', 'Session initial context is immutable');
        if ('createdWithAgentId' in patch && createdWithAgentId !== current.createdWithAgentId)
            throw new FSError('EINVAL', 'Session creation agent is immutable');
        const normalizedFolder = folder === undefined ? undefined : normalizeFolderPath(folder);
        if (normalizedFolder && normalizedFolder !== current.folder
            && !(await this.readFolderEntries(tx)).some(item => item.path === normalizedFolder)) {
            throw new FSError('ENOENT', 'Session folder not found');
        }
        const next = { ...current, ...(title !== undefined ? { title } : {}), ...(summary !== undefined ? { summary } : {}), ...(origin !== undefined ? { origin } : {}),
            ...(normalizedFolder !== undefined ? { folder: normalizedFolder } : {}),
            ...(uiState ? { uiState: { ...current.uiState, ...uiState, ...(uiState.branchDrafts ? { branchDrafts: { ...current.uiState?.branchDrafts, ...uiState.branchDrafts } } : {}) } } : {}), ...(flow ? { flow } : {}) };
        const historyChanged = await this.writeHistoryPatchTx(tx, p, historyPatch);
        if (!historyChanged && JSON.stringify(current) === JSON.stringify(next)) return false;
        const updatedAt = activityChanged(current, next, historyChanged) ? Date.now() : current.updatedAt;
        await tx.setEntry(p.session, 'session', JSON.stringify({ ...next, updatedAt, revision: current.revision + 1 }));
        if (updatedAt !== current.updatedAt || ['title', 'summary', 'origin', 'folder'].some(key => next[key] !== current[key]))
            await indexSessionSummary(tx, { ...next, updatedAt }, current);
        return true;
    }
    private async writeHistoryPatchTx(tx: ISeqFileTransaction, p: SessionPaths, patch: object): Promise<boolean> {
        if (!Object.keys(patch).length) return false;
        const index = JSON.parse(await tx.getEntry(p.history, 'index') ?? 'null');
        if (index?.schemaVersion !== 3) throw new Error('Session history version incompatible');
        const next = JSON.stringify({ ...index, ...patch, schemaVersion: 3 });
        if (JSON.stringify(index) === next) return false;
        await tx.setEntry(p.history, 'index', next);
        return true;
    }
    async getUIState(id: string): Promise<ConversationUIState | null> { return (await this.getManifest(id)).uiState ?? null; }
    async updateUIState(id: string, updates: Partial<ConversationUIState>): Promise<void> { await this.updateManifest(id, { uiState: updates }); }
    async getSessionSettings(id: string): Promise<ChatSessionSettings> {
        return (await this.getLoadState(id)).settings;
    }
    async saveSessionSettings(id: string, patch: Partial<ChatSessionSettings>): Promise<void> {
        await this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx), path = p.session;
            const manifest = await this.readManifestTx(tx, p, id);
            const current = sessionSettings(await tx.getEntry(path, 'settings'), manifest);
            await tx.setEntry(path, 'settings', JSON.stringify(mergeSessionSettings(current, patch)));
        });
        this.notify({ sessionId: id, kind: 'session' });
    }
    async readDocument(id: string, name: string): Promise<string | null> {
        const key = `document/${this.name(name)}`;
        return this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx);
            await this.readManifestTx(tx, p, id);
            return tx.getEntry(p.history, key);
        });
    }
    async writeDocument(id: string, name: string, content: string): Promise<void> {
        JSON.parse(content);
        const key = `document/${this.name(name)}`;
        await this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx);
            await this.readManifestTx(tx, p, id);
            await tx.setEntry(p.history, key, content);
        });
    }
    async listHistory(id: string): Promise<string[]> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const p = await this.paths(id, tx), names: string[] = [];
            await this.readManifestTx(tx, p, id);
            await tx.walkEntries(p.history, entry => { names.push(entry.key.slice('document/'.length)); return true; }, { keyPrefix: 'document/' });
            return names;
        });
    }
    async writeAttachment(id: string, name: string, content: ArrayBuffer): Promise<void> {
        await this.getManifest(id);
        await this.fs.driver.createFile({ name: this.name(name), parentPath: `${await this.root(id)}/attachments`, content, overwrite: true });
    }
    async openAttachments(id: string) {
        await this.getManifest(id);
        return createFileSystemView({ viewId: `attachments:${id}`, mounts: [{ mountId: 'attachments', at: '/', root: `${await this.root(id)}/attachments`, fs: this.fs, access: 'rw' }] });
    }
    async readSessionAsset(id: string, name: string): Promise<Blob | null> {
        const view = await this.openAttachments(id);
        try { const path = '/' + this.name(name.replace(/^@asset\//, '')); return await view.driver.exists(path) ? new Blob([await view.driver.readContent(path, { encoding: 'binary' })]) : null; }
        finally { await view.dispose(); }
    }
    private async readFolders(): Promise<SessionFolder[]> {
        if (!await this.fs.driver.exists(FOLDERS_PATH)) return [];
        return this.readFolderEntries(this.fs.meta.seq!);
    }
    /** Drop every record of the given seq files (records outlive deleted files). */
    private async clearEntries(paths: string[]): Promise<void> {
        await this.fs.meta.seq!.transaction!(async tx => {
            for (const path of paths) {
                const keys: string[] = [];
                await tx.walkEntries(path, entry => { keys.push(entry.key); return true; });
                for (const key of keys) await tx.deleteEntry(path, key);
            }
        });
    }
    /** Read-modify-write the folder record inside one transaction (no lost updates). */
    private async mutateFolders<T>(mutate: (folders: SessionFolder[]) => { folders: SessionFolder[]; result: T }): Promise<T> {
        await this.ensureFolderRecord();
        return this.fs.meta.seq!.transaction!(async tx => {
            const { folders, result } = mutate(await this.readFolderEntries(tx));
            await tx.setEntry(FOLDERS_PATH, FOLDERS_KEY, JSON.stringify(folders));
            await touchSessionRelations(tx);
            return result;
        });
    }
    private async readFolderEntries(tx: Pick<ISeqFileTransaction, 'getEntry'>): Promise<SessionFolder[]> {
        const raw = await tx.getEntry(FOLDERS_PATH, FOLDERS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new FSError('EIO', 'Invalid Session folder record');
        return parsed as SessionFolder[];
    }
    private async ensureFolderRecord(): Promise<void> {
        if (await this.fs.driver.exists(FOLDERS_PATH)) return;
        try {
            await this.fs.driver.createFile({ name: 'folders.seq', parentPath: '/var/lib/sessions', type: 'seqfile', recursive: true });
        } catch (error) {
            if (!(error instanceof FSError && error.code === 'EEXIST')) throw error;
        }
    }
}

function indexedHistoryCandidates(manifest: Pick<RoundManifest, 'currentHead' | 'children'>): string[] | null {
    if (!manifest.currentHead) return [];
    const parents = new Map<string, string>();
    for (const [parent, children] of Object.entries(manifest.children ?? {})) {
        for (const child of children) {
            const previous = parents.get(child);
            if (previous && previous !== parent) return null;
            parents.set(child, parent);
        }
    }
    const result: string[] = [], visited = new Set<string>();
    let current: string | undefined = manifest.currentHead;
    while (current && !visited.has(current)) {
        result.push(current); visited.add(current); current = parents.get(current);
    }
    return result;
}

function historyIndexMatches(candidates: string[], rounds: Array<PersistedRound | null>): boolean {
    return rounds.every((round, index) => !round
        || round.historyParentIds[0] === candidates[index + 1]);
}

function normalizeFolderPath(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === '/') return null;
    const parts = trimmed.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
        throw new FSError('EINVAL', 'Invalid Session folder path');
    }
    return '/' + parts.join('/');
}

/** Reading, scrolling and folding do not make an old conversation newly active. */
function activityChanged(before: ConversationManifest, after: ConversationManifest, historyChanged: boolean): boolean {
    return historyChanged || JSON.stringify({ ...before, uiState: undefined }) !== JSON.stringify({ ...after, uiState: undefined }) ||
        activeDrafts(before) !== activeDrafts(after);
}

function activeDrafts(manifest: ConversationManifest): string {
    // Editors initialize empty draft slots when opened; only actual text is activity.
    return JSON.stringify(Object.entries(manifest.uiState?.branchDrafts ?? {})
        .filter(([, draft]) => !!draft.inputText).sort(([a], [b]) => a.localeCompare(b)));
}

function folderParent(path: string): string | null {
    const index = path.lastIndexOf('/');
    return index <= 0 ? null : path.slice(0, index);
}

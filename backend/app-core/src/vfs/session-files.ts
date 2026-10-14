import type { FileSystemSourceOwner } from '@itookit/vfs-core';
import { createUnavailableDirectory } from './unavailable-directory';
import { createFileSystemView, normalizeVirtualPath, FSError, type FileSystemContextOwner, type FileSystemMount, type FileSystemView, type IFileSystem } from '@itookit/vfs-core';
import { createVFSToolContext } from './tool-context';

export interface SessionMountRecord {
    mountId: string;
    at: string;
    sourceId: string;
    root?: string;
    access: 'ro' | 'rw';
}
export interface FilesRecord {
    revision: number;
    state: 'active' | 'draining' | 'disabled';
    mounts: SessionMountRecord[];
    cwd: string;
}

/** Host-owned namespace configurations. Unconfigured sessions have no file grants. */
export class SessionFilesService {
    beforeAcquire?: (sessionId: string) => Promise<void>;
    workspaceComposer?: (id: string, mount: FileSystemMount) => Promise<FileSystemSourceOwner | undefined>;
    workspaceProvider?: (id: string, mount: SessionMountRecord) => Promise<FileSystemSourceOwner | undefined>;
    invalidate(id: string): Promise<void> {
        return this.serial(id, async () => { await this.revokeSessionViews(id); this.notify(); });
    }
    private readonly sources = new Map<string, IFileSystem>();
    private readonly unavailable = new Map<string, ReturnType<typeof createUnavailableDirectory>>();
    private readonly missingViews = new WeakMap<FileSystemView, Set<string>>();
    private readonly views = new Map<string, FileSystemView>();
    private readonly workspaceViews = new Map<string, Set<FileSystemView>>();
    private readonly tails = new Map<string, Promise<unknown>>();
    private recordsPath(id: string) { this.key(id); return `/var/lib/sessions/${id}/session.seq`; }
    private closed = false;
    private readonly listeners = new Set<() => void>();
    private readonly sourceSubscriptions: Array<() => void> = [];
    subscribe(listener: () => void): () => void { this.assertOpen(); this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private notify(): void { for (const listener of this.listeners) listener(); }


    constructor(private readonly store: IFileSystem,
        private readonly intrinsicMounts: (sessionId: string) => readonly FileSystemMount[] | Promise<readonly FileSystemMount[]> = () => [],
        /**
         * Resolve a source that is configured but not registered yet (saved host directories are
         * opened on first use). Returning undefined keeps the previous "source unavailable" path.
         */
        private readonly resolveSource?: (sourceId: string) => Promise<IFileSystem | undefined>) {}

    async initialize(): Promise<void> {
        if (!this.store.meta.seq?.transaction) throw new Error('Session namespaces require transactional SeqFiles');
    }

    /** Registered source for a mount id, or undefined while it is still unopened. */
    source(id: string): IFileSystem | undefined { this.assertOpen(); return this.sources.get(id); }

    /** Registration makes a source available to the host; it grants no Session access. */
    registerSource(id: string, source: IFileSystem): void {
        this.assertOpen();
        if (this.sources.has(id)) throw new Error(`Source already registered: ${id}`);
        this.sources.set(id, source);
        for (const [sessionId, view] of this.views) if (this.missingViews.get(view)?.has(id)) {
            this.views.delete(sessionId);
            if (view) void view.dispose().catch(() => {});
        }
        this.notify();
        if (source.onAny) this.sourceSubscriptions.push(source.onAny(() => this.notify()));
    }

    async inspect(sessionId: string): Promise<FilesRecord | null> {
        this.assertOpen();
        const path = this.recordsPath(sessionId);
        if (!await this.store.driver.exists(path)) return null;
        const raw = await this.store.meta.seq!.getEntry(path, 'files');
        if (!raw) return null;
        const record: FilesRecord = JSON.parse(raw);
        if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !['active', 'draining', 'disabled'].includes(record.state) || !Array.isArray(record.mounts) || typeof record.cwd !== 'string') {
            throw new FSError('EIO', 'Invalid or incompatible Session file configuration');
        }
        return record;
    }

    configure(sessionId: string, config: { mounts: SessionMountRecord[]; cwd: string }, expectedRevision: number): Promise<FilesRecord> {
        return this.serial(sessionId, async () => {
            const revision = nextFilesRevision(expectedRevision);
            const old = await this.inspect(sessionId);
            if ((old?.revision ?? 0) !== expectedRevision) throw new FSError('ECONFLICT', 'Namespace revision changed');
            const next: FilesRecord = { revision, state: 'active', mounts: structuredClone(config.mounts), cwd: normalizeVirtualPath(config.cwd) };
            const prepared = await this.create(sessionId, next);
            try {
                await this.save(sessionId, { ...next, state: 'draining' }, old);
                await this.revokeSessionViews(sessionId);
                await this.save(sessionId, next, { ...next, state: 'draining' });
                this.views.set(sessionId, prepared);
                this.notify();
                return next;
            } catch (error) { await prepared.dispose(); throw error; }
        });
    }

    disable(sessionId: string, expectedRevision: number): Promise<FilesRecord> {
        return this.serial(sessionId, async () => {
            const revision = nextFilesRevision(expectedRevision);
            const old = await this.inspect(sessionId);
            if ((old?.revision ?? 0) !== expectedRevision) throw new FSError('ECONFLICT', 'Namespace revision changed');
            const next: FilesRecord = { revision, state: 'disabled', mounts: [], cwd: '/' };
            const draining: FilesRecord = { ...next, state: 'draining' };
            await this.save(sessionId, draining, old);
            await this.revokeSessionViews(sessionId);
            await this.save(sessionId, next, draining);
            this.notify();
            return next;
        });
    }

    async acquire(sessionId: string) {
        const owner = await this.acquireFiles(sessionId);
        return { vfs: createVFSToolContext(owner.context), cwd: owner.context.cwd, release: owner.release };
    }

    /** Host-owned isolated copy; read-only acquisition attenuates all user mounts without changing grants. */
    acquireWorkspaceFiles(sessionId: string, mountId: string, fs: IFileSystem, access: 'ro' | 'rw' = 'rw'): Promise<FileSystemContextOwner> {
        return this.serial(sessionId, async () => {
            await this.beforeAcquire?.(sessionId);
            const record = await this.inspect(sessionId);
            const matches = record?.mounts.filter(item => item.mountId === mountId) ?? [];
            const mount = matches.length === 1 ? matches[0] : undefined;
            if (record?.state !== 'active' || !mount) throw new FSError('EACCES', 'Workspace requires an active Session mount');
            if (access === 'rw' && mount.access !== 'rw') throw new FSError('EROFS', 'Workspace requires a writable Session mount');
            const authorized = await this.create(sessionId, record);
            await authorized.dispose();
            const mounts = access === 'ro' ? record.mounts.map(item => ({ ...item, access: 'ro' as const })) : record.mounts;
            const view = await this.create(sessionId, { ...record, mounts, cwd: mount.at }, false, { mountId, fs });
            const views = this.workspaceViews.get(sessionId) ?? new Set<FileSystemView>();
            this.workspaceViews.set(sessionId, views);
            views.add(view);
            let released: Promise<void> | undefined;
            return { context: { fs: view, cwd: mount.at, sessionId }, release: () => released ??= (async () => {
                await view.dispose();
                views.delete(view);
                if (!views.size && this.workspaceViews.get(sessionId) === views) this.workspaceViews.delete(sessionId);
            })() };
        });
    }

    private async revokeSessionViews(sessionId: string): Promise<void> {
        // Close both admission gates before awaiting either drain.
        const closeOrdinary = async () => this.views.get(sessionId)?.dispose();
        const results = await Promise.allSettled([
            closeOrdinary(), this.revokeWorkspaces(sessionId),
        ]);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Session view revocation failed');
        this.views.delete(sessionId);
    }

    private async revokeWorkspaces(sessionId: string): Promise<void> {
        const views = this.workspaceViews.get(sessionId);
        if (!views) return;
        await Promise.all([...views].map(view => view.dispose()));
        this.workspaceViews.delete(sessionId);
    }

    /** Fixed revision: a change revokes all derived contexts, including tool scopes. */
    acquireFiles(sessionId: string, cwd?: string): Promise<FileSystemContextOwner> {
        return this.serial(sessionId, async () => {
            await this.beforeAcquire?.(sessionId);
            const { view: source, configuredCwd } = await this.get(sessionId);
            const directory = normalizeVirtualPath(cwd ?? configuredCwd);
            if (directory !== '/' && !await this.isDirectory(source, directory)) throw new FSError('ENOTDIR', 'Working directory is unavailable');
            const fs = createFileSystemView({ viewId: source.viewId, revision: source.revision,
                mounts: [{ mountId: 'session', at: '/', fs: source, access: 'rw' }] });
            return { context: { fs, cwd: directory, sessionId }, release: () => fs.dispose() };
        });
    }

    async dispose(): Promise<void> {
        this.closed = true;
        this.listeners.clear(); this.sourceSubscriptions.splice(0).forEach(off => off());
        await Promise.allSettled([...this.tails.values()]);
        await Promise.all([...new Set([...this.workspaceViews.keys(), ...this.views.keys()])].map(id => this.revokeSessionViews(id)));
        await Promise.all([...this.unavailable.values()].map(async source => (await source).dispose())); this.unavailable.clear();
    }

    /** Called inside the Session queue: cwd and grants belong to the same revision. */
    private async get(id: string): Promise<{ view: FileSystemView; configuredCwd: string }> {
        const record = await this.inspect(id);
        let view = this.views.get(id);
        if (view && (view.revision !== (record?.revision ?? 0) || record?.state !== 'active' && record !== null)) {
            await this.revokeSessionViews(id);
            view = undefined;
        }
        if (record?.state === 'draining') {
            // No process-local operations survive restart. Keep grants disabled until reconfigured.
            throw new FSError('EBUSY', 'Namespace reconfiguration requires recovery');
        }
        if (record?.state === 'disabled') throw new FSError('EACCES', 'Session files disabled');
        if (!view) {
            view = await this.create(id, record ?? { revision: 0, state: 'active', mounts: [], cwd: '/' }, true);
            this.views.set(id, view);
        }
        return { view, configuredCwd: record?.cwd ?? '/' };
    }
    private async create(id: string, record: FilesRecord, allowUnavailable = false,
        workspace?: { mountId: string; fs: IFileSystem }): Promise<FileSystemView> {
        this.key(id);
        const system = await this.intrinsicMounts(id);
        const missing = new Set<string>();
        const owners: FileSystemSourceOwner[] = [];
        const mounts: FileSystemMount[] = [];
        let view: FileSystemView;
        try {
            for (const mount of record.mounts) mounts.push(await this.prepareMount(id, mount, system,
                { owners, missing, allowUnavailable, replacement: workspace?.mountId === mount.mountId ? workspace.fs : undefined }));
            if (new Set(mounts.map(m => m.at)).size !== mounts.length) throw new FSError('EINVAL', 'Duplicate mount point');
            for (let index = 0; index < mounts.length; index++) {
                if (mounts[index].at !== '/workspace' || !this.workspaceComposer) continue;
                const owner = await this.workspaceComposer(id, mounts[index]);
                if (owner) { owners.push(owner); mounts[index] = { ...mounts[index], fs: owner.fs, root: '/' }; }
            }
            view = createFileSystemView({ viewId: `session:${id}`, revision: record.revision, mounts: [...system, ...mounts] });
        } catch (error) { await Promise.all(owners.map(owner => owner.dispose())); throw error; }
        const dispose = view.dispose.bind(view);
        let closing: Promise<void> | undefined;
        view.dispose = () => closing ??= (async () => { await dispose(); await Promise.all(owners.map(owner => owner.dispose())); })();
        this.missingViews.set(view, missing);
        try {
            if (record.cwd !== '/' && !await this.isDirectory(view, record.cwd)) throw new FSError('ENOTDIR', 'Working directory must be mounted');
            return view;
        } catch (error) { await view.dispose(); throw error; }
    }
    private async prepareMount(id: string, mount: SessionMountRecord, system: readonly FileSystemMount[],
        context: { owners: FileSystemSourceOwner[]; missing: Set<string>; allowUnavailable: boolean; replacement?: IFileSystem }): Promise<FileSystemMount> {
        const at = normalizeVirtualPath(mount.at);
        if (mount.access !== 'ro' && mount.access !== 'rw') throw new FSError('EINVAL', 'Invalid mount access');
        if (!/^\/[a-zA-Z0-9_-]+$/.test(at) || ['attachments', 'etc', 'var', 'dev', 'run', 'history', 'session'].includes(at.slice(1))) throw new FSError('EACCES', 'Reserved or invalid mount point');
        if (system.some(s => at === s.at)) throw new FSError('EACCES', 'Intrinsic mount cannot be overridden');
        try {
            const owner = !context.replacement && at === '/workspace' ? await this.workspaceProvider?.(id, mount) : undefined;
            if (owner) context.owners.push(owner);
            const root = normalizeVirtualPath(context.replacement || owner ? '/' : mount.root ?? '/');
            const fs = context.replacement ?? owner?.fs ?? this.sources.get(mount.sourceId) ?? await this.resolveSource?.(mount.sourceId);
            if (!fs) throw new FSError('EACCES', 'Namespace source is unavailable');
            const readonly = (await fs.capabilitiesAt(root)).readonly;
            if (!owner && mount.access === 'rw' && readonly) throw new FSError('EROFS', 'Source is read-only');
            if (!await this.isDirectory(fs, root)) throw new FSError('ENOTDIR', 'Mount source must be a directory');
            return { ...mount, root, at, access: owner && readonly ? 'ro' : mount.access, fs };
        } catch (error) {
            if (!context.allowUnavailable) throw error;
            if (!this.unavailable.has(mount.sourceId)) this.unavailable.set(mount.sourceId, createUnavailableDirectory(mount.sourceId));
            context.missing.add(mount.sourceId);
            return { ...mount, root: '/', at, fs: (await this.unavailable.get(mount.sourceId)!).fs };
        }
    }
    private async isDirectory(fs: IFileSystem, path: string): Promise<boolean> {
        const node = fs.driver.getNodeType ? await fs.driver.getNodeType(path) : await fs.driver.getNode(path);
        return node?.type === 'directory';
    }

    private async save(id: string, value: FilesRecord, expected: FilesRecord | null): Promise<void> {
        const path = this.recordsPath(id);
        if (!await this.store.driver.exists(path)) await this.store.driver.createFile({ name: 'session.seq', parentPath: `/var/lib/sessions/${id}`, type: 'seqfile', recursive: true });
        await this.store.meta.seq!.transaction!(async tx => {
            if (!await tx.compareAndSet(path, 'files', { expected: expected ? JSON.stringify(expected) : null, value: JSON.stringify(value) })) {
                throw new FSError('ECONFLICT', 'Namespace revision changed');
            }
        });
    }
    private key(id: string) { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new FSError('EINVAL', 'Invalid Session identity'); return `session/${id}`; }
    private assertOpen() { if (this.closed) throw new FSError('EACCES', 'Session file service is closed'); }
    private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new FSError('EACCES', 'Session file service is closed'));
        const next = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(() => { this.assertOpen(); return fn(); });
        this.tails.set(id, next);
        void next.finally(() => { if (this.tails.get(id) === next) this.tails.delete(id); }).catch(() => {});
        return next;
    }
}

function nextFilesRevision(expected: number): number {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) {
        throw new FSError('EINVAL', 'Invalid or exhausted Session files revision');
    }
    return expected + 1;
}

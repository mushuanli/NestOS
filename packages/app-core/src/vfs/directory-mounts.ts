import { WORKSPACE_PATH } from './workspace-namespace';
import { FSError, createFileSystemView, normalizeVirtualPath, type IFileSystem, type FileSystemSourceOwner } from '@itookit/vfs-core';
import { t } from '@itookit/common';
import type { SessionFilesService, SessionMountRecord } from './session-files';
import { randomUUID } from '@itookit/common';

export interface DirectorySourceProvider {
    selectDirectory(): Promise<string | null>;
    /** Returns a source rooted at exactly the selected directory. Owned by the provider. */
    openDirectory(path: string): Promise<IFileSystem>;
    dispose(): Promise<void>;
}
interface DirectoryRef { sourceId: string; root: string; label: string; }
interface Preferences { version: 1; home?: DirectoryRef; external: Record<string, string>; }
const preferencesPath = '/var/lib/kernel/local-sources/session-directories.json';

/** User commands and UI share this host-only service. It is never an Agent tool. */
export class DirectoryMountService {
    workspaceGuard?: (sessionId: string) => Promise<void>;
    private preferences: Preferences = { version: 1, external: {} };
    private closed = false;
    private tail: Promise<unknown> = Promise.resolve();
    private readonly connected = new Set<string>();
    constructor(private readonly root: IFileSystem, private readonly files: SessionFilesService,
        private readonly provider?: DirectorySourceProvider,
        private readonly beforeChange: (sessionId: string) => Promise<void> = async () => {},
        private readonly afterChange: (sessionId: string) => Promise<void> = async () => {},
        readonly fixedWorkspace: (sessionId: string) => Promise<string | undefined> = async () => undefined) {}
    async init(): Promise<void> {
        if (await this.root.driver.exists(preferencesPath)) {
            const saved = JSON.parse(await this.root.driver.readContent(preferencesPath, { encoding: 'utf-8' }));
            if (saved.version !== 1 || !saved.external || typeof saved.external !== 'object') throw new Error('Incompatible directory preferences');
            this.preferences = saved;
        }
        // Saved host directories are connected on first use (`resolveSource`), so startup does not
        // open a sidecar database for a bookmark no Session mounts yet.
    }
    /**
     * Open a configured host directory the first time a Session needs it.
     *
     * `SessionFilesService` calls this while building a Session view; an unreachable source stays
     * unavailable exactly as the previous eager connect left it, and is retried on the next use.
     */
    async resolveSource(sourceId: string): Promise<IFileSystem | undefined> {
        const registered = this.files.source(sourceId);
        if (registered) return registered;
        const path = this.preferences.external[sourceId];
        if (!path) return undefined;
        try { await this.connect(sourceId, path); } catch { /* Kept for explicit reconnection. Never substitute another source. */ }
        return this.files.source(sourceId);
    }
    async dispose(): Promise<void> { this.closed = true; await this.tail.catch(() => {}); }
    async listDirectories(path = '/home/admin'): Promise<string[]> {
        const normalized = normalizeVirtualPath(path);
        if (normalized !== '/home/admin' && !normalized.startsWith('/home/admin/')) throw new Error(t('mount.error.selectUserDirectory'));
        return (await this.root.driver.getChildren(normalized)).filter(node => node.type === 'directory').map(node => node.path);
    }
    describe(mount: SessionMountRecord): string {
        return mount.sourceId === 'admin-home' ? '/home/admin' + (mount.root === '/' ? '' : mount.root ?? '') : this.preferences.external[mount.sourceId] ?? mount.sourceId;
    }
    get canSelectHost(): boolean { return this.provider !== undefined; }
    async processMounts(sessionId: string): Promise<import('./session-process-context').SessionProcessMount[]> {
        await this.workspaceGuard?.(sessionId);
        const record = await this.files.inspect(sessionId);
        if (!record || record.state !== 'active') return [];
        return record.mounts.map(mount => {
            const source = mount.sourceId === 'admin-home' ? '/home/admin' : this.preferences.external[mount.sourceId];
            if (!source) throw new Error(`Process directory source unavailable: ${mount.sourceId}`);
            const suffix = mount.root && mount.root !== '/' ? mount.root : '';
            return { sourceId: mount.sourceId, directory: source.replace(/\/$/, '') + suffix,
                at: mount.at, access: mount.access };
        });
    }
    getHome(): string | undefined { return this.preferences.home?.label; }
    async chooseDirectory(): Promise<string | null> { return this.provider?.selectDirectory() ?? null; }
    /** A host-owned project view, rooted at the same directory used for Session grants. */
    openDirectory(directory: string): Promise<FileSystemSourceOwner> {
        return this.serial(async () => {
            const source = await this.resolve(directory);
            const internal = source.sourceId === 'admin-home';
            const fs = internal ? this.root : await this.provider!.openDirectory(this.preferences.external[source.sourceId]);
            const root = internal ? '/home/admin' + (source.root === '/' ? '' : source.root) : source.root;
            const view = createFileSystemView({ viewId: `project:${directory}`, mounts: [{ mountId: 'project', at: '/', fs, root, access: 'rw' }] });
            return { fs: view, dispose: () => view.dispose() };
        });
    }
    /** Read a project identity without registering sources or entering the mutation queue. */
    async inspectDirectory(directory: string): Promise<FileSystemSourceOwner> {
        const normalized = directory === '~' ? '/home/admin' : directory.startsWith('~/') ? '/home/admin/' + directory.slice(2) : directory;
        const internal = normalized === '/home/admin' || normalized.startsWith('/home/admin/');
        if (!internal && !this.provider) throw new FSError('ENOENT', 'Host directory source is unavailable', 'inspectDirectory', directory);
        const source = internal ? this.root : await this.provider!.openDirectory(normalized.replace(/^host:/, ''));
        const root = internal ? normalized : '/';
        const node = await source.driver.getNode(root);
        if (!node) throw new FSError('ENOENT', 'Project directory not found', 'inspectDirectory', directory);
        if (node.type !== 'directory') throw new FSError('ENOTDIR', 'Project source is not a directory');
        const fs = createFileSystemView({ viewId: `project-info:${directory}`, mounts: [{ mountId: 'project', at: '/', fs: source, root, access: 'rw' }] });
        return { fs, dispose: () => fs.dispose() };
    }
    setHome(directory: string): Promise<string> {
        return this.serial(async () => {
            const source = await this.resolve(directory);
            const previous = this.preferences.home;
            this.preferences.home = source;
            try { await this.persist(); } catch (error) { this.preferences.home = previous; throw error; }
            return t('mount.home.set', { label: source.label });
        });
    }
    mountHome(sessionId: string): Promise<string> {
        return this.serial(async () => {
            const home = this.preferences.home;
            if (!home) throw new Error(t('mount.error.setHomeFirst'));
            const path = this.preferences.external[home.sourceId];
            if (path) await this.connect(home.sourceId, path);
            return this.mount(sessionId, home, 'rw', WORKSPACE_PATH, true);
        });
    }
    addDirectory(sessionId: string, directory: string, access: 'ro' | 'rw' = 'rw', at?: string, asCwd = false): Promise<string> {
        return this.serial(async () => this.mount(sessionId, await this.resolve(directory), access, at, asCwd));
    }
    /** Explicitly replace the primary workspace grant, retaining unrelated mounts. */
    setWorkspace(sessionId: string, directory: string, access: 'ro' | 'rw' = 'rw'): Promise<string> {
        return this.serial(async () => this.mount(sessionId, await this.resolve(directory), access, WORKSPACE_PATH, true, true));
    }
    /** Boot recovery already holds the Session lease and runs before its tasks resume. */
    restoreWorkspace(sessionId: string, directory: string, access: 'ro' | 'rw'): Promise<string> {
        return this.serial(async () => this.mount(sessionId, await this.resolve(directory), access, WORKSPACE_PATH, true, true, true));
    }
    assertWorkspaceChange(sessionId: string): Promise<void> { return this.beforeChange(sessionId); }
    remove(sessionId: string, mountId: string): Promise<void> {
        return this.serial(async () => {
            await this.beforeChange(sessionId);
            const record = await this.files.inspect(sessionId); if (!record) return;
            const removed = record.mounts.find(m => m.mountId === mountId);
            const cwd = removed && (record.cwd === removed.at || record.cwd.startsWith(removed.at + '/')) ? '/' : record.cwd;
            await this.configure(sessionId, { mounts: record.mounts.filter(m => m.mountId !== mountId), cwd }, record);
            await this.afterChange(sessionId);
        });
    }
    reconnect(sessionId: string, mountId: string): Promise<void> {
        return this.serial(async () => {
            await this.beforeChange(sessionId);
            const record = await this.files.inspect(sessionId);
            const mount = record?.mounts.find(m => m.mountId === mountId);
            if (!record || !mount) throw new Error(t('mount.error.missing'));
            const path = this.preferences.external[mount.sourceId];
            if (path) await this.connect(mount.sourceId, path);
            await this.configure(sessionId, { mounts: record.mounts, cwd: record.cwd }, record);
            await this.afterChange(sessionId);
        });
    }
    update(sessionId: string, mountId: string, access: 'ro' | 'rw', asCwd: boolean): Promise<void> {
        return this.serial(async () => {
            await this.beforeChange(sessionId);
            const record = await this.files.inspect(sessionId);
            const mount = record?.mounts.find(m => m.mountId === mountId);
            if (!record || !mount) throw new Error(t('mount.error.missing'));
            await this.configure(sessionId, { mounts: record.mounts.map(m => m.mountId === mountId ? { ...m, access } : m), cwd: asCwd ? mount.at : record.cwd }, record);
            await this.afterChange(sessionId);
        });
    }
    private async mount(sessionId: string, source: DirectoryRef, access: 'ro' | 'rw', requestedAt?: string, asCwd = false, replace = false, recovering = false): Promise<string> {
        if (!recovering) await this.beforeChange(sessionId);
        const record = await this.files.inspect(sessionId);
        const mounts = record?.mounts ?? [];
        const same = mounts.find(m => m.sourceId === source.sourceId && (m.root ?? '/') === source.root);
        const name = source.label.split(/[\\/]/).filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_-]/g, '-') || 'directory';
        const at = normalizeVirtualPath(requestedAt ?? same?.at ?? '/' + name);
        if (!replace && mounts.some(m => m.at === at && m.mountId !== same?.mountId)) throw new Error(t('mount.error.pointExists', { at }));
        const mount: SessionMountRecord = { mountId: same?.mountId ?? randomUUID(), at, sourceId: source.sourceId, root: source.root, access };
        let cwd = record?.cwd ?? '/';
        if (same && (cwd === same.at || cwd.startsWith(same.at + '/'))) cwd = at + cwd.slice(same.at.length);
        await this.configure(sessionId, { mounts: [...mounts.filter(m => m.mountId !== same?.mountId && (!replace || m.at !== at)), mount],
            cwd: asCwd ? at : cwd }, record);
        await this.afterChange(sessionId);
        return t('mount.mounted', { label: source.label, at, access: t(access === 'ro' ? 'mount.access.ro' : 'mount.access.rw') });
    }
    private async configure(sessionId: string, next: { mounts: SessionMountRecord[]; cwd: string },
        previous: Awaited<ReturnType<SessionFilesService['inspect']>>): Promise<void> {
        const directory = await this.fixedWorkspace(sessionId);
        if (directory !== undefined) {
            const primary = next.mounts.find(m => m.at === WORKSPACE_PATH);
            const old = previous?.mounts.find(m => m.at === WORKSPACE_PATH);
            const expected = directory === '~' ? '/home/admin' : directory.startsWith('~/') ? '/home/admin/' + directory.slice(2) : directory;
            const internal = expected === '/home/admin' || expected.startsWith('/home/admin/');
            const label = internal ? normalizeVirtualPath(expected) : expected.replace(/^host:/, '');
            const sameSource = primary?.sourceId === old?.sourceId && primary?.root === old?.root;
            if (!primary || (primary.sourceId === 'admin-home') !== internal || this.describe(primary) !== label
                || next.cwd !== WORKSPACE_PATH || old && (sameSource && primary.access !== old.access || old.access === 'ro' && primary.access !== 'ro')) {
                throw new FSError('EACCES', t('mount.error.fixedWorkspace'));
            }
        }
        await this.files.configure(sessionId, next, previous?.revision ?? 0);
    }
    private async resolve(raw: string): Promise<DirectoryRef> {
        const path = raw.trim(); if (!path) throw new Error(t('mount.error.selectDirectory'));
        if (/^project:[a-zA-Z0-9_-]+$/.test(path)) return { sourceId: path, root: '/', label: path };
        const internal = path === '~' ? '/home/admin' : path.startsWith('~/') ? '/home/admin/' + path.slice(2) : path;
        if (internal === '/home/admin' || internal.startsWith('/home/admin/')) {
            const normalized = normalizeVirtualPath(internal);
            if (normalized !== '/home/admin' && !normalized.startsWith('/home/admin/')) throw new Error(t('mount.error.outOfUserScope'));
            const node = await this.root.driver.getNode(normalized);
            if (!node) throw new FSError('ENOENT', t('mount.error.notFound'), 'openDirectory', normalized);
            if (node.type !== 'directory') throw new FSError('ENOTDIR', 'Project source is not a directory', 'openDirectory', normalized);
            return { sourceId: 'admin-home', root: normalized.slice('/home/admin'.length) || '/', label: normalized };
        }
        if (!this.provider) throw new Error(t('mount.error.hostUnsupported'));
        const hostPath = path.startsWith('host:') ? path.slice(5) : path;
        let id = Object.entries(this.preferences.external).find(([, p]) => p === hostPath)?.[0];
        if (!id) {
            id = `directory-${randomUUID()}`;
            await this.connect(id, hostPath);
            this.preferences.external[id] = hostPath;
            try { await this.persist(); } catch (error) { delete this.preferences.external[id]; throw error; }
        } else await this.connect(id, hostPath);
        return { sourceId: id, root: '/', label: hostPath };
    }
    private async connect(id: string, path: string): Promise<void> {
        if (this.connected.has(id)) return;
        if (!this.provider) throw new Error(t('mount.error.sourceUnavailable'));
        this.files.registerSource(id, await this.provider.openDirectory(path)); this.connected.add(id);
    }
    private async persist(): Promise<void> {
        const content = JSON.stringify(this.preferences);
        if (await this.root.driver.exists(preferencesPath)) await this.root.driver.writeContent(preferencesPath, content);
        else await this.root.driver.createFile({ parentPath: '/var/lib/kernel/local-sources', name: 'session-directories.json', content, recursive: true });
    }
    private serial<T>(fn: () => Promise<T>): Promise<T> { if (this.closed) return Promise.reject(new Error('Directory mount service closed')); const next = this.tail.catch(() => {}).then(fn); this.tail = next; return next; }
}

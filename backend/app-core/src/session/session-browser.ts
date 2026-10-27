import { filterDirectoryFiles } from './directory-visibility';
import { SessionActivityProjection } from './session-activity';
import { RemoteSessionProjection } from './remote-session-projection';
import { conversationDirectory, conversationDirectoryNode, conversationNavigationNodes } from '../projects/conversation-directory';
import { conversationResourcePath } from '@itookit/app-contracts';
import { FOLDER_SEGMENT_PREFIX, isFolderSegment, isFileTarget, filesBrowserPrefix, parentBrowserPath, browserName,
    resolveBrowserTarget, browserTargetFolder, folderBrowserPath, folderPathFromBrowserPath, type FileTarget, type BrowserTarget } from './browser-routes';
export { resolveBrowserTarget, browserTargetFolder, folderBrowserPath, folderPathFromBrowserPath } from './browser-routes';
export type { BrowserTarget } from './browser-routes';
import { WORKSPACE_PATH, projectRelativePath } from '../vfs/workspace-namespace';
import { sessionFamilyRoots } from '../projects/session-family';
import { containedProjectRoots, projectFileLocation, type ProjectFileLocation, type ProjectFileRoot } from '../projects/file-location';
import { transferFileSystemEntry, checkOperation, createFileSystemSource, FSError, type FSNode, type IStorageBackend, type IFileSystem, type OperationOptions } from '@itookit/vfs-core';
import { t, ENTITY_ICONS, ACTION_ICONS, FILE_ICONS, fileTypeIcon, harnessPresentation } from '@itookit/common';
import type { ISessionRepository, SessionFolder } from '@itookit/llm-session';
import type { EventEnvelope, TaskRecord } from '@itookit/durable-kernel';
import { taskStat } from '@itookit/durable-kernel';
import type { SessionFilesService } from '@itookit/app-contracts/services';
import { exportSessionBundle, importSessionBundle, isSessionBundle } from './session-bundle';
import type { ProjectRemoteMount } from '../projects/remote-mounts';
import type { ProjectService } from '@itookit/app-contracts/services';
import { SessionLifecycleService } from './session-lifecycle';

/**
 * Project-owned state a file listing or file projection needs. Resolved once per call,
 * never per node: the project's remote grants plus an optional favorite lookup
 * (project file paths only).
 */
interface FileProjection {
    projectId: string;
    location(path: string): ProjectFileLocation;
    roots: ProjectFileRoot[];
    mounts: readonly ProjectRemoteMount[];
    offline: boolean;
    favorite(path: string, type: 'file' | 'directory'): boolean;
}

export function taskSummary(task: TaskRecord) {
    // `control.acknowledged` is false while a cancel is still waiting for the external stop to
    // be confirmed, so an observer can tell "requested" apart from "really stopped".
    const stat = taskStat(task);
    return { id: task.id, sessionId: task.sessionId, parentTaskId: task.parentTaskId, program: task.program,
        status: task.status, version: task.version, createdAt: task.createdAt, updatedAt: task.updatedAt,
        input: task.input, output: task.output, error: task.lastError,
        control: stat.control, activeOperations: stat.activeOperations };
}
/** User-facing timeline: omit scheduler chatter and streamed text already in the result. */
export function taskKeyEvent(event: EventEnvelope) {
    const type = event.type;
    const payload = event.payload && typeof event.payload === 'object'
        ? event.payload as Record<string, unknown> : undefined;
    const agentType = type === 'agent.event' && typeof payload?.type === 'string' ? payload.type : undefined;
    const key = agentType
        ? /^(tool:|skill:)/.test(agentType) || agentType === 'error'
        : /^(task\.interaction\.|task\.control\.|effect\.retry\.|effect\.resolved$|task\.attempt\.lost$|task\.program\.unavailable$)/.test(type)
            || ['task.failed', 'task.cancelled', 'effect.failed', 'effect.indeterminate', 'task.spawned'].includes(type);
    if (!key) return undefined;
    return { sequence: event.sequence, occurredAt: event.occurredAt, type: agentType ?? type, payload: event.payload };
}
export interface SessionBrowserDependencies {
    displayedFilesPolicy?: 'gitignore' | 'all';
    repository: ISessionRepository;
    projects?: ProjectService;
    files: SessionFilesService;
    kernel: import('@itookit/durable-kernel/contracts').KernelViewPort;
    /** Defaults to a service over `repository` and `kernel`. */
    lifecycle?: import('@itookit/app-contracts/services').SessionLifecycleService;
    /** Optional host presentation policy. Raw project/Session file APIs are unaffected. */
    filterDisplayedFiles?(fs: IFileSystem, nodes: FSNode[], signal?: AbortSignal): Promise<FSNode[]>;
}
interface FileDirectoryOptions extends OperationOptions { fs?: IFileSystem; node?: FSNode }
class BrowserBackend implements IStorageBackend {
    private agentFilter?: string;
    setSessionFilter(agentId?: string): void { this.agentFilter = agentId; this.invalidateNavigation(); }
    private get remoteSessions() { return new RemoteSessionProjection(this.deps.projects); }
    readonly name = 'session-browser';
    private readonly lifecycle: import('@itookit/app-contracts/services').SessionLifecycleService;
    private snapshot?: Promise<[SessionFolder[], import('@itookit/llm-session').SessionSummary[]]>;
    private folderSnapshot?: Promise<SessionFolder[]>;
    private directorySnapshots = new Map<string | null, Promise<import('@itookit/llm-session').SessionSummary[]>>();
    private subscriptions: Array<() => void> = [];
    private readonly activity: SessionActivityProjection;
    constructor(private readonly deps: SessionBrowserDependencies) {
        this.activity = new SessionActivityProjection(deps.kernel);
        this.lifecycle = deps.lifecycle ?? new SessionLifecycleService({ repository: deps.repository, kernel: deps.kernel });
    }
    async init() {
        this.subscriptions.push(this.deps.repository.subscribe(change => { if (change?.kind !== 'ui-state') this.invalidateNavigation(); }));
        if (this.deps.projects) this.subscriptions.push(this.deps.projects.subscribeChanges(() => this.invalidateNavigation()));
        const unsubscribe = this.deps.kernel.onChanged?.(event => {
            if (event.reason === 'content') return;
            this.activity.invalidate(event.sessionId);
        });
        if (unsubscribe) this.subscriptions.push(unsubscribe);
    }
    async close() { for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe(); this.activity.invalidate(); this.invalidateNavigation(); }
    invalidateNavigation(): void { this.snapshot = undefined; this.folderSnapshot = undefined; this.directorySnapshots.clear(); }
    refreshNavigation(options?: {activity?: boolean}): void {
        if (options?.activity !== false) this.activity.invalidate();
        this.invalidateNavigation();
    }
    private folders(): Promise<SessionFolder[]> {
        if (!this.folderSnapshot) {
            const work = this.deps.repository.listFolders().then(folders => this.deps.projects?.navigationFolders(folders) ?? folders);
            this.folderSnapshot = work;
            void work.catch(() => { if (this.folderSnapshot === work) this.folderSnapshot = undefined; });
        }
        return this.folderSnapshot;
    }
    private directoryNavigation(folder: string | null) {
        if (!this.deps.repository.listSummariesInFolder) return this.navigation();
        let rows = this.directorySnapshots.get(folder);
        if (!rows) {
            rows = this.deps.repository.listSummariesInFolder(folder);
            this.directorySnapshots.set(folder, rows);
            const pending = rows;
            void rows.catch(() => { if (this.directorySnapshots.get(folder) === pending) this.directorySnapshots.delete(folder); });
        }
        return Promise.all([this.folders(), rows]);
    }
    private navigation() {
        if (!this.snapshot) {
            const pending = Promise.all([this.folders(),
                this.deps.repository.listSummaries?.() ?? this.deps.repository.list()]);
            this.snapshot = pending;
            void pending.catch(() => { if (this.snapshot === pending) this.invalidateNavigation(); });
        }
        return this.snapshot;
    }
    async assertMutableSubtree(_path: string): Promise<void> {
        // Displayed tasks and mounted files are not owned Session storage. Session lifecycle
        // and delegated file mutations enforce the layout guard on the actual storage instead.
    }
    /** `readOnly` marks entries the backend refuses to mutate (Task history). */
    private node(path: string, title: string, directory: boolean, updatedAt = 0, readOnly = false): FSNode {
        const segment = path.split('/').pop() || '';
        const name = isFolderSegment(segment) ? decodeURIComponent(segment.slice(FOLDER_SEGMENT_PREFIX.length)) : segment;
        const base = { path, name, parentPath: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
            createdAt: updatedAt, modifiedAt: updatedAt, version: 1, tags: [],
            metadata: { title, _showAll: true, _fileDetails: false, ...(readOnly ? { _readOnly: true } : {}) }, icon: directory ? '📁' : '📋' };
        return directory ? { ...base, type: 'directory' } : { ...base, type: 'file', size: 0 };
    }
    private async withFiles<T>(target: FileTarget, fn: (fs: import('@itookit/vfs-core').IFileSystem) => Promise<T>): Promise<T> {
        if (target.kind === 'project-files') {
            if (!this.deps.projects) throw new FSError('ENOENT', 'Projects unavailable');
            const owner = await this.deps.projects.openWorkspace(target.folder);
            try { return await fn(owner.fs); } finally { await owner.dispose(); }
        }
        const owner = await this.deps.files.acquireFiles(target.sessionId);
        try { return await fn(owner.context.fs); } finally { await owner.release(); }
    }
    /**
     * Project-owned state a file listing needs. Resolved once per listing: the project,
     * its remote grants and — for project file paths — the favorite lookup. Favorites are
     * listed first so the cache-backed query and Session title reconciliation are current.
     */
    private async fileProjection(folder: string | null, withFavorites: boolean): Promise<FileProjection | undefined> {
        const projects = this.deps.projects;
        if (!projects) return undefined;
        const catalog = await projects.list(), project = await projects.forFolder(folder, catalog);
        if (!project) return undefined;
        const id = project.project.id;
        const mounts = projects.remoteMounts?.list(id) ?? [];
        const projection: FileProjection = { projectId: id, mounts, location: path => projectFileLocation(project, projectRelativePath(path), mounts),
            roots: catalog.map(item => ({ projectId: item.project.id, name: item.name,
                location: projectFileLocation(item, '/', projects.remoteMounts?.list(item.project.id) ?? []) })),
            offline: !!projects.remoteMounts?.projectOffline(id), favorite: () => false };
        if (!withFavorites) return projection;
        await projects.favorites.list(id);
        return { ...projection, favorite: (path, type) => projects.favorites.has(id, { kind: 'file', path, nodeType: type }) };
    }
    /** Folder that owns a Session or project file listing. */
    private async filesFolder(target: FileTarget): Promise<string | null> {
        if (target.kind === 'project-files') return target.folder;
        return (await this.deps.repository.getManifest(target.sessionId)).folder ?? null;
    }
    /** Favorite state only exists for project file paths, never for Session-owned files. */
    private projectProjection(target: FileTarget): Promise<FileProjection | undefined> {
        return target.kind === 'project-files' ? this.fileProjection(target.folder, true) : Promise.resolve(undefined);
    }
    private async mapped(fs: import('@itookit/vfs-core').IFileSystem, node: FSNode, prefix: string, projection?: FileProjection): Promise<FSNode> {
        const readOnly = node.metadata?._readOnly === true || (await fs.capabilitiesAt(node.path)).readonly;
        const routePath = (path: string) => prefix.endsWith('/@files') ? projectRelativePath(path) : path;
        const favorite = !!projection?.favorite(node.path, node.type === 'directory' ? 'directory' : 'file');
        const path = routePath(node.path), parent = path !== '/' && node.parentPath ? routePath(node.parentPath) : '/';
        const protectedRoots = projection && node.type === 'directory' && (node.path === WORKSPACE_PATH || node.path.startsWith(WORKSPACE_PATH + '/'))
            ? containedProjectRoots(projection.location(node.path), projection.roots) : [];
        return { ...node, ...(node.type === 'file' && node.assetDirPath ? { assetDirPath: prefix + routePath(node.assetDirPath) } : {}), path: prefix + (path === '/' ? '' : path), parentPath: path === '/' ? prefix.slice(0, prefix.lastIndexOf('/')) || '/' : prefix + (parent === '/' ? '' : parent), metadata: { ...node.metadata, _favorite: favorite, _showAll: true, _fileDetails: true, _readOnly: readOnly,
            ...(protectedRoots.length ? { _fixedEntry: true, projectStorageRoots: protectedRoots.map(root => root.projectId),
                navigationDescription: t('project.error.storageRoot', { projects: protectedRoots.map(root => root.name).join(', ') }) } : {}),
            ...(node.metadata?.unavailable ? { _disabled: true, navigationDescription: t('remote.state.offline') } : {}) } };
    }
    private sessionBrowserPath(id: string, folder: string | null | undefined): string {
        return `${folderBrowserPath(folder)}/${id}`;
    }
    private sessionNode(manifest: { id: string; title: string; createdAt: number; updatedAt: number; folder?: string | null; parentSessionId?: string | null; createdWithAgentId?: string }): FSNode {
        const source = harnessPresentation('nestos');
        return { ...this.node(this.sessionBrowserPath(manifest.id, manifest.folder), manifest.title, true, manifest.updatedAt),
            createdAt: manifest.createdAt, icon: source.icon, metadata: { title: manifest.title, createdWithAgentId: manifest.createdWithAgentId, harnessKind: 'nestos', harnessLabel: source.label, _favorite: this.deps.projects?.favorites.hasSession(manifest.id), _showAll: true, _fileDetails: false, parentSessionId: manifest.parentSessionId ?? null } };
    }
    private sessionNodes(sessions: import('@itookit/llm-session').SessionSummary[], folder: string | null, agentId: string | null = this.agentFilter ?? null): FSNode[] {
        sessions = sessions.filter(session => !agentId || session.createdWithAgentId === agentId);
        const roots = sessionFamilyRoots(sessions);
        const byId = new Map(sessions.map(session => [session.id, session]));
        const counts = new Map<string, number>();
        for (const root of roots.values()) counts.set(root, (counts.get(root) ?? 0) + 1);
        return sessions.filter(item => (item.folder ?? null) === folder).map(item => {
            const node = this.sessionNode(item), root = roots.get(item.id)!;
            return { ...node, metadata: { ...node.metadata, familyRoot: root, familyCount: counts.get(root) ?? 1,
                parentTitle: byId.get(item.parentSessionId ?? '')?.title ?? '' } };
        });
    }
    private folderNode(folder: SessionFolder): FSNode {
        const title = folder.name === '@sessions' ? t('project.sessions') : (folder as SessionFolder & { displayName?: string }).displayName ?? folder.name;
        const node = this.node(folderBrowserPath(folder.path), title, true, folder.updatedAt);
        const remote = this.deps.projects?.remoteMounts;
        const mounts = folder.project && remote ? remote.list(folder.project.id) : [];
        const remoteRoot = folder.project?.source?.kind === 'remote' || mounts.some(mount => mount.at === '/');
        const offline = !!folder.project && !!remote && mounts.some(mount => remote.status(mount.mountId) === 'offline');
        // A shadowed or unavailable source is reported on the drawer instead of only inside the
        // mount dialog, so the workbench shows why a project is degraded.
        const degraded = !!folder.project && !!remote && remote.degraded(folder.project.id);
        return { ...node, ...(folder.project ? { icon: remoteRoot ? ENTITY_ICONS.remoteProject : ENTITY_ICONS.project } : {}),
            metadata: { ...node.metadata, renameTitle: folder.name, ...(folder.name === '@sessions' ? { navigationTransparent: true } : {}), ...(folder.project ? { projectId: folder.project.id, directory: folder.project.directory, remoteProject: remoteRoot,
                remoteOffline: offline, _disabled: false, _readOnly: offline,
                navigationDescription: mounts.length ? t(offline ? 'remote.projectOffline' : degraded ? 'remote.degraded' : 'remote.projectRemote') : '' } : {}) } };
    }
    private isFolderContainer(path: string): boolean {
        if (path === '/') return true;
        try { return resolveBrowserTarget(path).kind === 'folder'; } catch { return false; }
    }
    private async sessionBundle(id: string): Promise<Uint8Array> {
        return new TextEncoder().encode((await exportSessionBundle(this.deps.repository, id)).content);
    }
    async stat(path: string): Promise<FSNode | null> {
        const resource = conversationResourcePath(path);
        if (resource !== path) {
            const node = await this.stat(resource);
            return node && {...node, path, name: path.slice(path.lastIndexOf('/') + 1), parentPath: parentBrowserPath(path),
                metadata: {...node.metadata, navigationTarget: resource}};
        }
        if (path === '/') return this.node('/', 'Sessions', true);
        let target: BrowserTarget;
        try { target = resolveBrowserTarget(path); }
        catch (error) { if (error instanceof FSError && error.code === 'EINVAL') return null; throw error; }
        if (target.kind === 'folder') {
            const folderPath = folderPathFromBrowserPath(path);
            if (!folderPath) return this.node('/', 'Sessions', true);
            // Folder stats are projection reads; reuse the same catalog the listings use so a
            // path-prefix check does not re-read the folder record.
            const folders = await this.folders();
            const folder = folders.find(item => item.path === folderPath);
            return folder ? this.folderNode(folder) : null;
        }
        if (target.kind === 'remote') return this.remoteSessions.stat(path, target);
        if (target.kind === 'project-conversations') {
            const project = await this.deps.projects?.forFolder(target.folder);
            const node = conversationDirectoryNode(target.folder, target.recent, target.cursor);
            return project?.path === target.folder ? {...node, path, parentPath: parentBrowserPath(path), name: browserName(path)} : null;
        }
        if (target.kind === 'project-draft') {
            const project = (await this.folders()).find(folder => folder.path === target.folder);
            return this.projectDraft(project) ? this.draftEntry(path) : null;
        }
        if (target.kind === 'favorites') return this.favoritesEntry(path);
        if (target.kind === 'favorite') return (await this.favoriteNodes(parentBrowserPath(path), target.folder)).find(node => node.path === path) ?? null;
        if (target.kind === 'project-files') {
            if (target.path === WORKSPACE_PATH) {
                const project = await this.deps.projects?.forFolder(target.folder);
                return project ? this.fileEntry(path, target.folder) : null;
            }
            return this.statFiles(path, target);
        }
        let manifest;
        try { manifest = await this.deps.repository.getManifest(target.sessionId); }
        catch (error) { if (error instanceof FSError && error.code === 'ENOENT') return null; throw error; }
        if (target.kind === 'session') return (await this.activity.nodes([this.sessionNode(manifest)]))[0]!;
        if (target.kind === 'tasks') return this.node(path, path.endsWith('/@more') ? t('session.tasks.more') : 'tasks', !path.endsWith('/@more'), 0, true);
        if (target.kind === 'task') {
            const task = await this.deps.kernel.task(target.sessionId, target.taskId);
            return this.node(path, `${task.program.kind} · ${task.status} · ${task.id}`, false, task.updatedAt, true);
        }
        return this.statFiles(path, target);
    }
    private async statFiles(path: string, target: FileTarget): Promise<FSNode | null> {
        const prefix = filesBrowserPrefix(path);
        const projection = await this.projectProjection(target);
        return this.withFiles(target, async fs => {
            if (target.path === '/') return this.node(path, t('project.files'), true, 0, (await fs.capabilitiesAt('/')).readonly);
            const node = await fs.driver.getNode(target.path);
            if (!node) return null;
            const hidden = this.deps.filterDisplayedFiles && !(await this.deps.filterDisplayedFiles(fs, [node])).length;
            return this.mapped(fs, { ...node, metadata: { ...node.metadata, _hiddenInBrowser: !!hidden } }, prefix, projection);
        });
    }
    async list(path: string): Promise<FSNode[]> {
        return this.activity.nodes(await this.listNodes(path));
    }
    private async listNodes(path: string): Promise<FSNode[]> {
        // The root projection reuses the shared catalog like every folder does. Writes that
        // change the catalog invalidate it through `repository.subscribe` / `kernel.onChanged`,
        // and hosts can force a re-read with the owner's `invalidateNavigation` (see `init`).
        if (path === '/') {
            const [folders, sessions] = await this.directoryNavigation(null);
            return [
                ...folders.filter(folder => !folder.parentPath).map(folder => this.folderNode(folder)),
                ...this.sessionNodes(sessions, null),
            ];
        }
        const target = resolveBrowserTarget(path);
        if (target.kind === 'folder') {
            const folderPath = folderPathFromBrowserPath(path);
            const [folders, sessions] = await this.directoryNavigation(folderPath);
            const project = folders.find(folder => folder.path === folderPath);
            return [
                ...folders.filter(folder => folder.parentPath === folderPath && !(project?.project && folder.name === '@sessions')).map(folder => this.folderNode(folder)),
                ...(this.deps.projects && folders.find(folder => folder.path === folderPath)?.project
                    ? [await this.fileEntry(path + '/@files', folderPath), this.favoritesEntry(path + '/@favorites')] : []),
                ...(this.deps.projects && this.projectDraft(project) ? [this.draftEntry(path + '/@new')] : []),
                ...(project?.project ? conversationNavigationNodes(project.path) : this.sessionNodes(sessions, folderPath)),
            ];
        }
        if (target.kind === 'project-conversations') return this.projectConversations(path, target);
        if (target.kind === 'remote') return this.remoteSessions.list(path, target);
        if (target.kind === 'project-draft') return [];
        if (target.kind === 'favorites') return this.favoriteNodes(path, target.folder);
        if (target.kind === 'favorite') return [];
        if (target.kind === 'project-files') return this.listFiles(path, target);
        await this.deps.repository.getManifest(target.sessionId);
        if (target.kind === 'session') return [this.node(path + '/tasks', 'tasks', true, 0, true), this.node(path + '/files', 'files', true, 0, true)];
        if (target.kind === 'tasks') {
            if (path.endsWith('/@more')) throw new FSError('ENOTDIR', 'Open the paginated Task list');
            let exists = false;
            for await (const session of this.deps.kernel.listSessions()) if (session.id === target.sessionId) { exists = true; break; }
            if (!exists) return [];
            const page = await this.deps.kernel.listSessionTaskPage(target.sessionId);
            const nodes = page.items.map(t => this.node(`${path}/${t.id}`, `${t.program.kind} · ${t.status} · ${t.id}`, false, t.updatedAt, true));
            if (page.nextAfterIndex !== undefined) nodes.push(this.node(`${path}/@more`, t('session.tasks.more'), false, 0, true));
            return nodes;
        }
        if (target.kind === 'files') return this.listFiles(path, target);
        throw new FSError('ENOTDIR', 'Task is a history entry');
    }
    private async projectConversations(path: string, target: Extract<BrowserTarget, {kind: 'project-conversations'}>): Promise<FSNode[]> {
        const project = await this.deps.projects?.forFolder(target.folder);
        if (!project || project.path !== target.folder) throw new FSError('ENOENT', 'Project unavailable');
        const folders = await this.folders();
        const groups = [project.path, ...folders.filter(folder => folder.parentPath === project.path && folder.name === '@sessions').map(folder => folder.path)];
        const agentId = this.agentFilter;
        const local = Promise.all(groups.map(async folder => {
            const [, sessions] = await this.directoryNavigation(folder);
            return this.sessionNodes(sessions, folder, agentId ?? null);
        })).then(rows => rows.flat());
        return conversationDirectory(path, target, local, () => this.remoteSessions.timeline(project, agentId), agentId);
    }
    private async listFiles(path: string, target: FileTarget): Promise<FSNode[]> {
        return this.withFiles(target, fs => this.fileNodes(path, target, fs));
    }
    private async fileNodes(path: string, target: FileTarget, fs: IFileSystem, options?: OperationOptions,
        projection = this.fileProjectionFor(target)): Promise<FSNode[]> {
        const prefix = filesBrowserPrefix(path);
        const pending = [projection, fs.driver.getChildren(target.path, options)] as const;
        let state: FileProjection | undefined, raw: FSNode[];
        try { [state, raw] = await Promise.all(pending); } finally { await Promise.allSettled(pending); }
        const visible = this.deps.filterDisplayedFiles ? await this.deps.filterDisplayedFiles(fs, raw, options?.signal) : raw;
        const nodes = await Promise.all(visible.filter(node => node.path !== '/workspace/.nestos' && !this.isOtherProjectRoot(node, state))
            .map(node => this.mapped(fs, node, prefix, state)));
        return nodes.map(node => this.withMountStatus(node, prefix, target, state));
    }
    private async fileProjectionFor(target: FileTarget): Promise<FileProjection | undefined> {
        return this.fileProjection(await this.filesFolder(target), target.kind === 'project-files');
    }
    /** One source and projection for the directory header and its rows. */
    async readFileDirectory(path: string, options: FileDirectoryOptions = {}): Promise<{node: FSNode; nodes: FSNode[]}> {
        const target = resolveBrowserTarget(path);
        if (!isFileTarget(target)) throw new FSError('ENOTDIR', 'Not a file directory');
        checkOperation(options);
        const {fs: supplied, node: known, ...operation} = options;
        const read = async (fs: IFileSystem) => {
            const projection = this.fileProjectionFor(target);
            const pending = [known ?? fs.driver.getNode(target.path, operation), this.fileNodes(path, target, fs, operation, projection), projection] as const;
            let node: FSNode | null, nodes: FSNode[], state: FileProjection | undefined;
            try { [node, nodes, state] = await Promise.all(pending); } finally { await Promise.allSettled(pending); }
            checkOperation(options);
            if (!node) throw new FSError('ENOENT', 'Directory not found');
            if (node.type !== 'directory') throw new FSError('ENOTDIR', 'Not a directory');
            const mapped = await this.mapped(fs, node, filesBrowserPrefix(path), state);
            const root = target.kind === 'project-files' ? target.path === WORKSPACE_PATH : target.path === '/';
            const directory = root ? {...mapped, metadata: {...mapped.metadata,
                ...(target.kind === 'project-files' ? {_fixedEntry: true, _fileDetails: false} : {}), title: t('project.files')}} : mapped;
            return {node: this.withMountStatus(directory, filesBrowserPrefix(path), target, state), nodes};
        };
        return supplied ? read(supplied) : this.withFiles(target, read);
    }
    private isOtherProjectRoot(node: FSNode, projection?: FileProjection): boolean {
        if (!projection || node.type !== 'directory' || !(node.path === WORKSPACE_PATH || node.path.startsWith(WORKSPACE_PATH + '/'))) return false;
        const location = projection.location(node.path);
        return projection.roots.some(root => root.projectId !== projection.projectId
            && root.location.namespace === location.namespace && root.location.path === location.path);
    }
    /** Annotate a listed row with the remote grant that owns it, if any. */
    private withMountStatus(node: FSNode, prefix: string, target: FileTarget, projection?: FileProjection): FSNode {
        const remote = this.deps.projects?.remoteMounts, offline = !!projection?.offline;
        const relative = node.path.slice(prefix.length).replace(target.kind === 'files' ? /^\/workspace(?=\/|$)/ : /^$/, '');
        const mount = remote && projection?.mounts.find(item => relative === item.at || relative.startsWith(item.at + '/'));
        if (!mount || !remote) return offline ? { ...node, metadata: { ...node.metadata, _disabled: true, _readOnly: true } } : node;
        const status = remote.status(mount.mountId);
        return { ...node, ...(relative === mount.at ? { icon: ENTITY_ICONS.remoteProject } : {}),
            metadata: { ...node.metadata, remoteMountId: mount.mountId, _disabled: offline || status === 'offline', _readOnly: offline || node.metadata._readOnly,
                navigationDescription: relative === mount.at ? t(`remote.state.${status}`) : node.metadata.navigationDescription } };
    }
    private projectDraft(folder?: SessionFolder): boolean {
        return !!folder?.project;
    }
    private draftEntry(path: string): FSNode {
        const node = this.node(path, t('project.createSession'), false, 0, true);
        return {...node, icon: ENTITY_ICONS.chat, metadata: {...node.metadata, _fixedEntry: true}};
    }
    private favoritesEntry(path: string): FSNode {
        const node = this.node(path, t('project.favorites'), true);
        return { ...node, icon: ACTION_ICONS.favorite,
            metadata: { ...node.metadata, _fixedEntry: true, _readOnly: true } };
    }
    private async favoriteNodes(path: string, folder: string): Promise<FSNode[]> {
        const project = await this.deps.projects?.forFolder(folder);
        if (!project || !this.deps.projects) return [];
        const offline = this.deps.projects.remoteMounts?.projectOffline(project.project.id);
        const items = await this.deps.projects.favorites.list(project.project.id);
        return items.map(item => ({ ...this.node(`${path}/${item.id}`, item.title, false),
            icon: item.target.kind === 'remote-session' ? ENTITY_ICONS.remoteSession : item.target.kind === 'session' ? ENTITY_ICONS.chat : fileTypeIcon(item.target.path, item.target.nodeType === 'directory'),
            metadata: { title: item.title, _fixedEntry: true, _readOnly: true, _favorite: true, _showAll: true, _fileDetails: false,
                _disabled: item.target.kind === 'file' && !!offline, favoriteId: item.id, favoriteProjectId: project.project.id,
                navigationDescription: item.target.kind === 'remote-session' ? t(offline ? 'remote.projectOffline' : 'harness.remoteSessions') : item.target.kind === 'file' ? item.target.path : t('project.favoriteSession') } }));
    }
    /** The fixed `Files` entry: its own read-only state and favorite flag, not a listing. */
    private async fileEntry(path: string, folder: string | null): Promise<FSNode> {
        const projection = await this.fileProjection(folder, true);
        const offline = !!projection?.offline;
        const availability = offline ? { readOnly: true } : await this.fileAvailability(folder);
        const disabled = offline || !!availability.reason;
        const node = this.node(path, t('project.files'), true);
        return { ...node, icon: FILE_ICONS.folder, metadata: { ...node.metadata,
            _favorite: projection?.favorite(WORKSPACE_PATH, 'directory') ?? false, _fixedEntry: true, _disabled: disabled, _readOnly: availability.readOnly,
            ...(disabled ? { navigationDescription: offline ? t('remote.projectOffline') : t('project.filesUnavailable', { reason: availability.reason! }) } : {}) } };
    }
    private async fileAvailability(folder: string | null): Promise<{ readOnly: boolean; reason?: string }> {
        try { return { readOnly: !!folder && !!await this.deps.projects?.workspaceReadOnly(folder) }; }
        catch (error) {
            // A missing source must not hide the project's Sessions and navigation entries.
            if (!(error instanceof FSError) || !['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
            return { readOnly: true, reason: error.message };
        }
    }
    private async assertAvailable(path: string): Promise<void> {
        if (!this.deps.projects?.remoteMounts) return;
        const target = resolveBrowserTarget(path);
        const folder = browserTargetFolder(target, path,
            'sessionId' in target ? (await this.deps.repository.getManifest(target.sessionId)).folder : undefined);
        const project = await this.deps.projects.forFolder(folder);
        if (project && this.deps.projects.remoteMounts.projectOffline(project.project.id)) throw new FSError('EACCES', 'Remote project unavailable');
    }
    async read(path: string): Promise<Uint8Array> {
        const target = resolveBrowserTarget(path);
        if (isFileTarget(target)) await this.assertAvailable(path);
        if (target.kind === 'favorite' || target.kind === 'favorites') throw new FSError('EISDIR', 'Open favorites through navigation');
        if (target.kind === 'folder' || target.kind === 'project-conversations') throw new FSError('EISDIR', 'Open this folder using its browser target');
        if (target.kind === 'remote') throw new FSError('EROFS', 'Remote sessions use the conversation port');
        if (target.kind === 'project-draft') throw new FSError('EROFS', 'Project drafts use the composer port');
        if (target.kind === 'session') return this.sessionBundle(target.sessionId);
        if (isFileTarget(target)) return this.withFiles(target, async fs => new Uint8Array(await fs.driver.readContent(target.path, { encoding: 'binary' })));
        await this.deps.repository.getManifest(target.sessionId);
        if (target.kind === 'task') {
            const task = await this.deps.kernel.task(target.sessionId, target.taskId);
            return new TextEncoder().encode(JSON.stringify(taskSummary(task), null, 2));
        }
        throw new FSError('EISDIR', 'Open this entry using its browser target');
    }
    async mkdir(path: string): Promise<FSNode> {
        await this.assertAvailable(parentBrowserPath(path));
        const parent = parentBrowserPath(path);
        if (this.isFolderContainer(parent)) {
            if (parent === '/' && this.deps.projects) {
                const project = await this.deps.projects.create(browserName(path));
                return this.folderNode(project);
            }
            const folderPath = `${folderPathFromBrowserPath(parent) ?? ''}/${browserName(path)}`;
            const folder = await this.deps.repository.createFolder(folderPath);
            return this.folderNode(folder);
        }
        const target = resolveBrowserTarget(path);
        if (isFileTarget(target)) {
            const prefix = filesBrowserPrefix(path), projection = await this.projectProjection(target);
            return this.withFiles(target, async fs => {
                const node = await fs.driver.createDirectory({ parentPath: parentBrowserPath(target.path), name: browserName(target.path) });
                return this.mapped(fs, node, prefix, projection);
            });
        }
        throw new FSError('EROFS', 'Use the Session file context for this path');
    }
    async write(path: string, content: Uint8Array): Promise<FSNode> {
        if (path.endsWith('/@new') && resolveBrowserTarget(path).kind === 'project-draft') throw new FSError('EROFS', 'Project drafts use the composer port');
        await this.assertAvailable(path);
        const parent = parentBrowserPath(path);
        if (this.isFolderContainer(parent)) {
            const text = new TextDecoder().decode(content);
            const folder = folderPathFromBrowserPath(parent);
            const title = browserName(path).replace(/\.[^.]+$/, '');
            // A bundle restores its index and documents; any other file at folder
            // level is a new empty Session named after it (sidebar file creation).
            const id = isSessionBundle(text)
                ? await importSessionBundle(this.deps.repository, text, { folder })
                : await this.deps.repository.createSession(title || 'Imported Session', folder);
            return this.sessionNode(await this.deps.repository.getManifest(id));
        }
        const target = resolveBrowserTarget(path);
        if (isFileTarget(target)) {
            const prefix = filesBrowserPrefix(path), projection = await this.projectProjection(target);
            const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
            return this.withFiles(target, async fs => {
                if (await fs.driver.exists(target.path)) {
                    await fs.driver.writeContent(target.path, buffer);
                    const node = await fs.driver.getNode(target.path);
                    if (!node) throw new FSError('EIO', 'Session file disappeared after write');
                    return this.mapped(fs, node, prefix, projection);
                }
                const node = await fs.driver.createFile({ parentPath: parentBrowserPath(target.path), name: browserName(target.path), content: buffer });
                return this.mapped(fs, node, prefix, projection);
            });
        }
        throw new FSError('EROFS', 'Only Session folders and Session files are writable');
    }
    async delete(path: string): Promise<void> {
        const entry = resolveBrowserTarget(path);
        if (entry.kind === 'project-files' && entry.path === WORKSPACE_PATH) return;
        await this.assertAvailable(path);
        const target = resolveBrowserTarget(path);
        if (target.kind === 'folder') {
            const folderPath = folderPathFromBrowserPath(path);
            if (!folderPath) throw new FSError('EINVAL', 'Cannot delete the Session browser root');
            if (folderPath.endsWith('/@sessions')) throw new FSError('EACCES', 'Cannot delete the Sessions section');
            const projects = (await this.deps.projects?.list() ?? []).filter(project => project.path === folderPath || project.path.startsWith(folderPath + '/'));
            // Busy check before the destructive delete: once the Sessions are gone the lease and
            // active-Task guard can no longer see them.
            for (const project of projects) await this.deps.projects?.remoteMounts?.assertUnmountable(project.project.id);
            // Revoke persisted grants before removing navigation and project identities.
            // If grant storage fails, the project must remain visible for retry.
            for (const project of projects) await this.deps.projects?.remoteMounts?.forgetProject(project.project.id);
            await this.lifecycle.deleteFolder(folderPath, true);
            for (const project of projects) {
                await this.deps.projects?.removeProjectSource(project);
            }
            return;
        }
        if (target.kind === 'session') {
            await this.lifecycle.deleteSession(target.sessionId);
            return;
        }
        if (isFileTarget(target)) {
            if (target.path === '/' || target.kind === 'project-files' && target.path === WORKSPACE_PATH) throw new FSError('EACCES', 'Cannot delete a file root');
            await this.assertOrdinaryFile(target);
            await this.withFiles(target, fs => fs.driver.delete([target.path], { recursive: true }));
            return;
        }
        throw new FSError('EROFS', 'Tasks are read-only');
    }
    async rename(from: string, to: string): Promise<void> {
        const entry = resolveBrowserTarget(from);
        if (entry.kind === 'project-files' && entry.path === WORKSPACE_PATH) return;
        await this.assertAvailable(from); await this.assertAvailable(parentBrowserPath(to));
        const targetPath = to.startsWith('/') ? to : `${parentBrowserPath(from)}/${to}`;
        const source = resolveBrowserTarget(from);
        if (source.kind === 'session') {
            const manifest = await this.deps.repository.getManifest(source.sessionId);
            const destination = folderPathFromBrowserPath(parentBrowserPath(targetPath));
            if (this.deps.projects && !await this.deps.projects.forFolder(destination)) throw new FSError('EACCES', 'Sessions require a project destination');
            if (this.deps.projects && (destination !== manifest.folder || !await this.deps.projects.sessionMoves.ready(source.sessionId))) {
                await this.deps.projects.sessionMoves.move(source.sessionId, destination!);
            }
            await this.deps.repository.updateManifest(source.sessionId, {
                title: browserName(targetPath) === browserName(from) ? manifest.title : browserName(targetPath).replace(/\.[^.]+$/, ''),
                folder: folderPathFromBrowserPath(parentBrowserPath(targetPath)),
            });
            return;
        }
        if (source.kind === 'folder') {
            const fromFolder = folderPathFromBrowserPath(from);
            const parentFolder = folderPathFromBrowserPath(parentBrowserPath(targetPath));
            if (!fromFolder) throw new FSError('EINVAL', 'Cannot rename the Session browser root');
            if (fromFolder.endsWith('/@sessions')) throw new FSError('EACCES', 'Cannot rename the Sessions section');
            const folders = await this.deps.repository.listFolders();
            const containsProject = folders.some(folder => folder.project && (folder.path === fromFolder || folder.path.startsWith(fromFolder + '/')));
            await this.deps.projects?.assertMove(fromFolder, parentFolder, containsProject);
            const next = `${parentFolder ?? ''}/${browserName(targetPath)}`;
            const project = folders.find(folder => folder.path === fromFolder)?.project;
            if (project && this.deps.projects) await this.deps.projects.renameProject(fromFolder, next);
            else await this.deps.repository.renameFolder(fromFolder, next);
            return;
        }
        if (isFileTarget(source)) {
            await this.assertOrdinaryFile(source);
            const destination = resolveBrowserTarget(targetPath);
            if (!isFileTarget(destination)) throw new FSError('EACCES', 'Files require a file directory destination');
            if (filesBrowserPrefix(from) !== filesBrowserPrefix(targetPath)) {
                if (browserName(from) !== browserName(targetPath)) throw new FSError('EINVAL', 'Move and rename separately');
                await this.transfer('move', [from], parentBrowserPath(targetPath));
                return;
            }
            if (source.path === '/') throw new FSError('EACCES', 'Cannot rename a file root');
            await this.withFiles(source, async fs => {
                if (parentBrowserPath(source.path) === parentBrowserPath(destination.path)) {
                    await fs.driver.rename(source.path, browserName(destination.path));
                } else {
                    if (browserName(source.path) !== browserName(destination.path)) throw new FSError('EINVAL', 'Move and rename separately');
                    await fs.driver.move([source.path], parentBrowserPath(destination.path));
                }
            });
            return;
        }
        throw new FSError('EROFS', 'Unsupported browser rename');
    }
    async transfer(mode: 'copy' | 'move', ids: string[], destinationPath: string): Promise<void> {
        const destination = resolveBrowserTarget(destinationPath);
        if (!isFileTarget(destination)) throw new FSError('EACCES', 'Files require a file directory destination');
        if (ids.some(id => parentBrowserPath(id) === destinationPath)) throw new FSError('EINVAL', 'Transfer destination is already the source directory');
        const roots = [...new Set(ids)].filter(id => !ids.some(parent => id !== parent && id.startsWith(parent + '/')));
        for (const id of roots) {
            const source = resolveBrowserTarget(id);
            if (!isFileTarget(source) || source.path === '/' || source.kind === 'project-files' && source.path === WORKSPACE_PATH)
                throw new FSError('EACCES', 'Cannot transfer a browser navigation entry');
            await this.assertOrdinaryFile(source);
            await this.assertTransferPaths(source, destination);
            const sameNamespace = filesBrowserPrefix(id) === filesBrowserPrefix(destinationPath);
            await this.withFiles(source, async fs => {
                if (mode === 'move' && sameNamespace) {
                    try { await fs.driver.move([source.path], destination.path); return; }
                    catch (error) { if (!(error instanceof FSError) || error.code !== 'EXMOUNT') throw error; }
                }
                await this.withFiles(destination, target => transferFileSystemEntry(fs, source.path,
                    target, destination.path, { move: mode === 'move', sameNamespace }));
            });
        }
    }
    private async assertTransferPaths(source: FileTarget, destination: FileTarget): Promise<void> {
        if (source.kind !== 'project-files' || destination.kind !== 'project-files' || !this.deps.projects) return;
        const from = await this.deps.projects.forFolder(source.folder), to = await this.deps.projects.forFolder(destination.folder);
        if (!from || !to) throw new FSError('ENOENT', 'Transfer project unavailable');
        const remote = this.deps.projects.remoteMounts;
        const origin = projectFileLocation(from, projectRelativePath(source.path), remote?.list(from.project.id) ?? []);
        const target = projectFileLocation(to, projectRelativePath(destination.path).replace(/\/$/, '') + '/' + browserName(source.path), remote?.list(to.project.id) ?? []);
        if (origin.namespace === target.namespace && (target.path === origin.path || target.path.startsWith(origin.path + '/'))) {
            throw Object.assign(new FSError('EINVAL', t('project.error.transferOverlap', { source: `${from.name}: ${origin.label}`, target: `${to.name}: ${target.label}` })),
                { sourceProjectId: from.project.id, targetProjectId: to.project.id, sourceLocation: origin, targetLocation: target });
        }
    }
    private async assertOrdinaryFile(target: FileTarget): Promise<void> {
        if (!this.deps.projects || !(target.path === WORKSPACE_PATH || target.path.startsWith(WORKSPACE_PATH + '/'))) return;
        const projection = await this.fileProjection(await this.filesFolder(target), false);
        if (!projection) return;
        const location = projection.location(target.path), protectedRoots = containedProjectRoots(location, projection.roots);
        if (!protectedRoots.length) return;
        throw Object.assign(new FSError('EBUSY', t('project.error.storageRoot', { projects: protectedRoots.map(root => root.name).join(', ') })),
            { sourceLocation: location, protectedProjects: protectedRoots });
    }
    async updateMetadata(path: string, metadata: Record<string, unknown>): Promise<void> {
        const target = resolveBrowserTarget(path);
        if (target.kind === 'session') {
            await this.deps.repository.updateManifest(target.sessionId, {
                ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
            });
            return;
        }
        if (isFileTarget(target)) {
            await this.withFiles(target, fs => fs.driver.updateMetadata(target.path, metadata));
            return;
        }
        throw new FSError('EROFS', 'Metadata is read-only for this entry');
    }
    async setTags(path: string, tags: string[]): Promise<void> {
        const target = resolveBrowserTarget(path);
        if (!isFileTarget(target)) throw new FSError('EROFS', 'Tags are read-only for this entry');
        await this.withFiles(target, async fs => {
            if (!fs.meta.tags) throw new FSError('EROFS', 'Tags are unavailable');
            await fs.meta.tags.setTags(target.path, tags);
        });
    }
    async getAllTags(): Promise<string[]> { return []; }
}
export async function createSessionBrowser(deps: SessionBrowserDependencies): Promise<import('@itookit/app-contracts/services').SessionBrowserPort> {
    const backend = new BrowserBackend(deps.displayedFilesPolicy === 'gitignore' ? { ...deps, filterDisplayedFiles: filterDirectoryFiles } : deps);
    const owner = await createFileSystemSource({ tags: false, backend, viewId: 'session-browser:admin', access: 'rw' });
    const rename = owner.fs.driver.rename.bind(owner.fs.driver);
    owner.fs.driver.rename = async (path, name, options) => {
        checkOperation(options);
        if (!name || /[/\\\0]/.test(name) || ['.', '..'].includes(name)) throw new FSError('EINVAL', 'Invalid rename name');
        const target = resolveBrowserTarget(path);
        if (target.kind === 'session') {
            await owner.fs.driver.updateMetadata(path, { title: name.replace(/\.[^.]+$/, '') });
            return;
        }
        // Folder routes are encoded identities; display names are never event paths.
        const segment = target.kind === 'folder' ? FOLDER_SEGMENT_PREFIX + encodeURIComponent(name) : name;
        await rename(path, segment, options);
    };
    return Object.assign(owner, { transferItems: (mode: 'copy' | 'move', ids: string[], destination: string) => backend.transfer(mode, ids, destination),
        readFileDirectory: (path: string, options?: FileDirectoryOptions) => backend.readFileDirectory(path, options),
        invalidateNavigation: async (options?: {activity?: boolean}) => { backend.refreshNavigation(options); },
        setSessionFilter: async (agentId?: string) => { backend.setSessionFilter(agentId); } });
}

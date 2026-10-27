import { projectFileSource, projectWorkspaceAccess, projectNavigation } from '@itookit/app-contracts';
import { trackFavoriteFiles } from './favorites/lifecycle';
import type { MCPDeletedProject } from '../configuration/model-commands';
import { overlappingProjectRoots, projectFileLocation, type ProjectFileRoot } from './file-location';
import { ProjectSessionMoves } from './session-moves';
import { recoverProjectDirectories } from './project-directory-recovery';
import { ProjectRepository, type StoredProject } from './project-repository';
import { ProjectDefaults } from './project-defaults';
import { ProjectFavorites, SeqProjectFavoriteStore } from './favorites';
import { WORKSPACE_PATH } from '../vfs/workspace-namespace';
import type { ProjectExecutionService } from './execution/service';
import { ProjectDraftStore } from './drafts/store';
import { ProjectDraftService } from './drafts/service';
import {RemoteDraftRecovery} from './drafts/remote-submission';
import type { ProjectRemoteMountService } from '@itookit/app-contracts/services';
import { ProjectSessions } from './project-sessions';
import { readProjectNavigation } from './navigation-view';
import { randomUUID, t } from '@itookit/common';
import { FSError, createFileSystemView, normalizeVirtualPath, type IFileSystem, type OperationOptions } from '@itookit/vfs-core';
import type { ISessionRepository, SessionFolder } from '@itookit/llm-session';
import type { DirectoryMountService } from '@itookit/app-contracts/services';
import type { SessionFilesService } from '@itookit/app-contracts/services';

export type ProjectFolder = SessionFolder & { displayName?: string } & { project: NonNullable<SessionFolder['project']> };
export type ProjectFileSource = { kind: 'local'; directory: string } | { kind: 'remote'; reference: string };

/** Project identity and file roots survive navigation-folder renames and moves. */
export class ProjectService {
    async navigation(request: import('@itookit/app-contracts/services').ProjectNavigationRequest) {
        return readProjectNavigation(this, this.repository, request, await this.defaultProjects.getId());
    }
    execution?: ProjectExecutionService;
    private remote?: ProjectRemoteMountService;
    get remoteMounts(): ProjectRemoteMountService | undefined { return this.remote; }
    set remoteMounts(remote: ProjectRemoteMountService | undefined) {
        this.remote = remote;
        if (remote) remote.rootValidator = async (id, mount) => {
            if (mount.access === 'rw' && (!mount.connectionId || !remote.connection(mount.connectionId).projects))
                throw new FSError('ECAPABILITY', 'Writable remote projects require the server project protocol');
            await this.assertIndependent(await this.get(id), [mount]);
        };
    }
    private startupId?: string;
    private readonly defaultProjects: ProjectDefaults;
    private remoteCreation: Promise<unknown> = Promise.resolve();
    private localCreation: Promise<unknown> = Promise.resolve();
    readonly sessions: ProjectSessions;
    readonly drafts: ProjectDraftService;
    readonly favorites: ProjectFavorites;
    readonly sessionMoves: ProjectSessionMoves;
    private readonly projectRepository: ProjectRepository;
    constructor(private readonly root: IFileSystem, private readonly repository: ISessionRepository,
        private readonly directories: DirectoryMountService, private readonly files: SessionFilesService, initializeDraftExecution?: (sessionId: string) => Promise<void>) {
        this.sessions = new ProjectSessions(repository, folders => this.navigationFolders(folders));
        this.favorites = new ProjectFavorites(new SeqProjectFavoriteStore(root), async projectId => {
            const [sessions, folders] = await Promise.all([(repository.listSummaries?.() ?? repository.list()), repository.listFolders()]);
            const project = folders.find(folder => folder.project?.id === projectId);
            return new Map(sessions.filter(session => project && (session.folder === project.path || session.folder?.startsWith(project.path + '/')))
                .map(session => [session.id, session.title]));
        });
        const remoteDrafts = new RemoteDraftRecovery(root, id => this.remoteMounts?.list(id) ?? []);
        this.drafts = new ProjectDraftService(id => new ProjectDraftStore(root, id), repository, async () => (await this.list()).map(item => item.project.id), async id => {
            const project = await this.get(id);
            if (project.project.source?.kind === 'remote' || this.remoteMounts?.list(id).some(mount => mount.at === '/'))
                throw new FSError('EACCES', 'Remote project drafts require a remote executor');
        }, (id, record) => remoteDrafts.receipt(id, record), initializeDraftExecution,
            (id, record) => remoteDrafts.assertResettable(id, record));
        this.sessionMoves = new ProjectSessionMoves(root, repository, directories, files, this);
        this.projectRepository = new ProjectRepository(root, directories);
        this.defaultProjects = new ProjectDefaults(root, () => this.list(), replacement => this.createUnique(t(replacement ? 'project.default.replacementName' : 'project.defaultName')),
            project => this.fileSource(project).kind === 'local');
        repository.setStorageDirectoryResolver?.(async folder => {
            const project = folder === null ? await this.current() : await this.forFolder(folder);
            if (!project) return undefined;
            const stored = (await this.projectRepository.list()).find(item => item.id === project.project.id)!;
            return this.projectRepository.sessionDirectory(stored);
        });
        this.configureGuards(); this.configureWorkspaceSources();
    }
    private configureGuards(): void {
        const { files, directories } = this;
        const acquireGuard = files.beforeAcquire;
        files.beforeAcquire = async id => {
            await acquireGuard?.(id);
            if (!await this.sessionMoves.ready(id)) throw new FSError('EBUSY', 'Session project move requires recovery');
            const project = await this.sessionProject(id);
            if (project) await this.assertIndependent(project);
        };
        directories.workspaceGuard = async id => {
            const project = await this.sessionProject(id);
            if (!project) return;
            await this.assertIndependent(project);
            if (this.fileSource(project).kind === 'remote') throw new FSError('EACCES', 'Remote projects cannot use local process directories');
            const grant = (await files.inspect(id))?.mounts.find(mount => mount.at === WORKSPACE_PATH);
            if (grant && directories.describe(grant) !== project.project.directory)
                throw new FSError('EACCES', 'Project workspace grant requires migration');
        };
    }
    private configureWorkspaceSources(): void {
        const { files } = this;
        const previousComposer = files.workspaceComposer;
        files.workspaceProvider = async (id, mount) => {
            const project = await this.sessionProject(id);
            if (!project) return undefined;
            await this.assertIndependent(project);
            if (this.fileSource(project).kind === 'remote') return this.openFiles(project.path);
            if (this.directories.describe(mount) === project.project.directory) return undefined;
            if (!project.project.directory.startsWith('/home/admin/')) throw new FSError('EACCES', 'Project workspace grant requires migration');
            const fs = createFileSystemView({ viewId: `migrated-project:${id}`, mounts: [{ mountId: 'project', at: '/',
                fs: this.root, root: project.project.directory, access: mount.access }] });
            return { fs, dispose: () => fs.dispose() };
        };
        files.workspaceComposer = async (id, mount) => {
            const project = await this.sessionProject(id);
            if (!project || this.fileSource(project).kind === 'remote' || !this.remote?.list(project.project.id).length) return previousComposer?.(id, mount);
            const fs = createFileSystemView({ viewId: `project-base:${id}`, mounts: [{ ...mount, at: '/' }] });
            return this.remote.compose(project.project.id, { fs, dispose: () => fs.dispose() });
        };
    }

    get canSelectDirectory(): boolean { return this.directories.canSelectHost; }
    private async sessionProject(id: string): Promise<ProjectFolder | undefined> {
        try { return this.forFolder((await this.repository.getManifest(id)).folder); }
        catch (error) { if (error instanceof FSError && error.code === 'ENOENT') return undefined; throw error; }
    }
    dispose(): void { this.projectRepository.dispose(); }
    chooseDirectory() { return this.directories.chooseDirectory(); }
    /** When the caller already read the folder catalog, reuse it instead of re-reading. */
    async list(folders?: readonly SessionFolder[]): Promise<ProjectFolder[]> {
        const navigation = folders ?? await this.repository.listFolders();
        return (await this.projectRepository.list()).map(project => this.projectFolder(project, navigation));
    }
    private projectFolder(project: StoredProject, folders: readonly SessionFolder[]): ProjectFolder {
        const cached = folders.find(folder => folder.project?.id === project.id);
        const path = `${cached?.parentPath ?? ''}/${project.navigationName ?? project.name}`;
        const connection = this.remoteMounts?.list(project.id).find(mount => mount.at === '/')?.connectionId;
        const server = this.remoteMounts?.connections().find(item => item.id === connection);
        return { path, name: project.name,displayName:server ? `${server.name}:${project.name}` : project.name, parentPath: cached?.parentPath ?? null, updatedAt: project.createdAt,
            project: { id: project.id, directory: project.directory, source: { kind: project.kind } } };
    }
    navigationFromIndex = false;
    listNavigation(folders: readonly SessionFolder[]): ProjectFolder[] {
        return projectNavigation(folders, this.remoteMounts);
    }
    async navigationFolders(folders?: readonly SessionFolder[]): Promise<SessionFolder[]> {
        const cached = folders ?? await this.repository.listFolders();
        const projects = this.navigationFromIndex ? this.listNavigation(cached) : await this.list(cached);
        const children = cached.filter(folder => !folder.project && projects.some(project =>
            folder.path.startsWith(project.path + '/') || project.path.startsWith(folder.path + '/')));
        // Directory identities can exist before their Session organization records.
        // Reads expose the fixed section without mutating the authoritative catalog.
        const sections = projects.filter(project => !children.some(folder => folder.path === project.path + '/@sessions'))
            .map(project => ({ path: project.path + '/@sessions', name: '@sessions', parentPath: project.path, updatedAt: project.updatedAt }));
        return [...projects, ...children, ...sections];
    }
    private legacyRecovery?: Promise<void>;
    private legacyFailures = new Map<string, unknown>();
    private recoverLegacyDirectories(): Promise<void> {
        if (this.legacyRecovery) return this.legacyRecovery;
        const work = recoverProjectDirectories({ root: this.root, repository: this.repository,
            identities: this.projectRepository, directories: this.directories,
            check: (path, project) => this.assertIndependent({ path, name: path.split('/').pop()!, parentPath: null, updatedAt: Date.now(), project }),
        }).then(failures => { this.legacyFailures = failures; });
        this.legacyRecovery = work;
        return work.finally(() => { if (this.legacyRecovery === work) this.legacyRecovery = undefined; });
    }
    async initializeSources(): Promise<void> {
        await this.recoverLegacyDirectories();
        const storedProjects = await this.projectRepository.list();
        let folders = await this.repository.listFolders();
        for (const stored of storedProjects) {
            const project = this.projectFolder(stored, folders);
            const cached = folders.find(folder => folder.project?.id === project.project.id);
            if (!cached) {
                const slot = folders.find(folder => folder.path === project.path);
                if (slot && !slot.project) await this.repository.promoteProjectFolder!(project.path, project.project);
                else await this.repository.createFolder(project.path, project.project);
            }
            else if (cached.path !== project.path) await this.repository.renameFolder(cached.path, project.path);
            if (!cached || cached.path !== project.path) folders = await this.repository.listFolders();
            await this.repository.indexProjectSessions?.(this.projectRepository.sessionDirectory(stored));
        }
    }
    subscribeChanges(listener: () => void): () => void { return this.root.onAny?.(() => listener()) ?? (() => {}); }
    async renameProject(from: string, to: string): Promise<void> {
        const project = await this.forFolder(from);
        if (!project || project.path !== from) throw new FSError('ENOENT', 'Project not found');
        const stored = (await this.projectRepository.list()).find(item => item.id === project.project.id)!;
        const name = to.split('/').pop()!;
        const sessions = await this.repository.list();
        await this.repository.assertStructuralWritable(sessions.filter(item => item.folder === from || item.folder?.startsWith(from + '/')).map(item => item.id));
        await this.projectRepository.rename(stored, name);
        try { await this.repository.renameFolder(from, to); }
        catch (error) {
            const current = (await this.projectRepository.list()).find(item => item.id === stored.id)!;
            await this.projectRepository.rename(current, stored.name,stored.navigationName); throw error;
        }
    }
    async removeProjectSource(project: ProjectFolder): Promise<void> {
        const next = await this.defaultProjects.remove(project.project.id, async () => {
            const stored = (await this.projectRepository.list()).find(item => item.id === project.project.id);
            if (stored) await this.projectRepository.remove(stored);
        });
        if (next) this.startupId = next.project.id;
    }
    async storedProjectIds(): Promise<string[]> {
        return (await this.projectRepository.list()).map(project => project.id);
    }
    async inspectRemoteProjectRemoval(ids: readonly string[]): Promise<MCPDeletedProject[]> {
        const records = (await this.projectRepository.list()).filter(record => record.kind === 'remote' && ids.includes(record.id));
        const sessions = await this.repository.list();
        const projects = await this.list();
        return records.map(record => {
            const project = projects.find(item => item.project.id === record.id)!;
            return {id:record.id,name:record.name,path:project.path,localSessions:sessions
                .filter(session => session.folder === project.path || session.folder?.startsWith(project.path + '/'))
                .map(session => ({id:session.id,title:session.title})).sort((a,b) => a.id.localeCompare(b.id))};
        }).sort((a,b) => a.id.localeCompare(b.id));
    }
    async removeRemoteProjectRecord(id: string, deleteFolder: (path: string) => Promise<void>): Promise<void> {
        const record = (await this.projectRepository.list()).find(project => project.id === id);
        if (!record) return;
        if (record.kind !== 'remote') throw new FSError('EACCES','Cannot delete a local project through an MCP configuration');
        const project = await this.get(id);
        await deleteFolder(project.path);
        await this.projectRepository.remove(record);
    }
    async get(id: string): Promise<ProjectFolder> {
        const project = (await this.list()).find(item => item.project.id === id);
        if (!project) throw new FSError('ENOENT', 'Project not found');
        return project;
    }
    async forFolder(path: string | null | undefined, folders?: readonly SessionFolder[]): Promise<ProjectFolder | undefined> {
        const projects = folders && this.navigationFromIndex ? this.listNavigation(folders) : await this.list(folders);
        return projects.filter(folder => path === folder.path || path?.startsWith(folder.path + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0];
    }
    async current(): Promise<ProjectFolder | undefined> {
        const projects = this.navigationFromIndex ? this.listNavigation(await this.repository.listFolders()) : await this.list();
        return projects.find(folder => folder.project.id === this.startupId) ?? await this.getDefaultProject()
            ?? projects.find(project => this.fileSource(project).kind === 'local') ?? projects[0];
    }
    getDefaultProject(): Promise<ProjectFolder | undefined> { return this.defaultProjects.get(); }
    async setDefaultProject(id: string): Promise<void> {
        await this.defaultProjects.set(id);
        this.startupId = id;
    }
    create(name: string, parent: string | null = null, directory?: string): Promise<ProjectFolder> {
        const work = this.localCreation.catch(() => {}).then(() => this.createLocal(name, parent, directory));
        this.localCreation = work; return work;
    }
    private async assertName(name: string, parent: string | null): Promise<string> {
        if (!name.trim() || /[/\\\0]/.test(name) || ['.', '..', '@sessions'].includes(name.trim())) throw new FSError('EINVAL', t('project.error.name'));
        if (await this.forFolder(parent)) throw new FSError('EINVAL', t('project.error.nested'));
        const path = normalizeVirtualPath(`${parent ?? ''}/${name.trim()}`);
        await this.prepareCreationPath(path);
        return path;
    }
    private async prepareCreationPath(path: string): Promise<void> {
        await this.recoverLegacyDirectories();
        const folders = await this.repository.listFolders(), projects = await this.list(folders);
        if (projects.some(project => project.path === path || project.path.startsWith(path + '/'))) throw new FSError('EEXIST', t('project.error.exists'));
        const cached = folders.find(folder => folder.path === path);
        if (!cached) return;
        if (cached.project && this.legacyFailures.has(cached.project.directory)) throw this.legacyFailures.get(cached.project.directory);
        const live = cached.project && projects.find(project => project.project.id === cached.project!.id);
        const target = live?.path ?? `/.retired-project-${cached.project?.id ?? 'folder'}-${randomUUID()}`;
        // Preserve Session ownership and original file roots; only free the stale navigation name.
        await this.repository.renameFolder(cached.path, target);
        console.warn('[Project index] Reconciled stale name', { path, projectId: cached.project?.id,
            directory: cached.project?.directory, relocatedIndex: target, reason: live ? 'identity-renamed' : 'identity-not-discovered' });
    }
    private async createLocal(name: string, parent: string | null, directory?: string): Promise<ProjectFolder> {
        const path = await this.assertName(name, parent);
        const id = randomUUID();
        const target = directory?.trim() ?? `/home/admin/projects/${id}`;
        if (!target || target.startsWith('project:')) throw new FSError('EINVAL', 'Local projects require a file directory');
        await this.assertIndependent({ path, name: name.trim(), parentPath: parent, updatedAt: Date.now(),
            project: { id, directory: target, source: { kind: 'local' } } });
        if (!directory) await this.root.driver.createDirectory({ parentPath: '/home/admin/projects', name: id, recursive: true });
        let project: ProjectFolder | undefined;
        try {
            const source = await this.directories.openDirectory(target); await source.dispose();
            if (target.startsWith('/home/admin/')) await this.repository.validateProjectSessions?.(`${target}/.nestos/sessions`);
            await this.projectRepository.createLocal(target, { version: 1, id, name: name.trim(), createdAt: Date.now() });
            project = await this.repository.createFolder(path, { id, directory: target, source: { kind: 'local' } }) as ProjectFolder;
            await this.sessionFolder(project);
            return project;
        } catch (error) {
            const failures: unknown[] = [error];
            try { if (project) await this.repository.deleteFolder(path, true); } catch (cleanup) { failures.push(cleanup); }
            try { if (!directory && failures.length === 1) await this.root.driver.delete([target], { recursive: true }); } catch (cleanup) { failures.push(cleanup); }
            if (failures.length > 1) throw new AggregateError(failures, 'Project creation and cleanup failed');
            throw error;
        }
    }

    createRemote(name: string, parent: string | null, connectionId: string, path: string,
        access: 'ro' | 'rw' = 'ro', options?: OperationOptions & {createDirectory?: boolean}): Promise<ProjectFolder> {
        const work = this.remoteCreation.catch(() => {}).then(async () => {
            const remote = this.remoteMounts;
            if (!remote) throw new FSError('ECAPABILITY', 'Remote file systems unavailable');
            if (access==='rw' && !remote.connection(connectionId).projects) throw new FSError('ECAPABILITY','Writable remote projects require the server project protocol');
            const existing = await remote.findRemoteProject(connectionId, path);
            if (existing) {
                const project = (await this.list()).find(item => item.project.id === existing);
                if (project) return project;
                await remote.forgetProject(existing);
            }
            const id = randomUUID();
            const projectPath = await this.remoteNavigationPath(name,parent,id);
            const navigationName = projectPath.split('/').pop()!;
            await this.projectRepository.createRemote({version:1,id,name:name.trim(),createdAt:Date.now(),
                ...(navigationName !== name.trim() ? {navigationName} : {})});
            let project: ProjectFolder | undefined;
            try {
                project = await this.repository.createFolder(projectPath, { id, directory: `project:${id}`, source: { kind: 'remote' } }) as ProjectFolder;
                await remote.bindProject(id, connectionId, path, access, {...options,projectName:name.trim()});
                await this.sessionFolder(project); return this.get(id);
            }
            catch (error) {
                // A published grant must remain recoverable if view invalidation fails.
                if (!remote.list(id).length) {
                    const stored = (await this.projectRepository.list()).find(item => item.id === id);
                    if (stored) await this.projectRepository.remove(stored);
                    if (project) await this.repository.deleteFolder(project.path, true);
                }
                throw error;
            }
        });
        this.remoteCreation = work; return work;
    }

    private async remoteNavigationPath(name: string, parent: string | null, id: string): Promise<string> {
        if ((await this.list()).some(project => project.project.source?.kind === 'remote' && project.name === name.trim()))
            return this.assertName(`${name.trim()}~${id}`,parent);
        try { return await this.assertName(name,parent); }
        catch (error) {
            if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;
            return this.assertName(`${name.trim()}~${id}`,parent);
        }
    }

    /** Rollback hook for a fresh managed project whose navigation records were removed. */
    async discardImportedProject(project: ProjectFolder): Promise<void> {
        const directory = `/home/admin/projects/${project.project.id}`;
        if (project.project.directory !== directory || (await this.repository.listFolders()).some(item => item.project?.id === project.project.id))
            throw new FSError('EACCES', 'Project is not eligible for import rollback');
        await this.root.driver.delete([directory], { recursive: true });
    }
    async ensureDirectory(directory: string, label?: string): Promise<ProjectFolder> {
        const existing = (await this.list()).find(folder => folder.project.directory === directory);
        if (existing) return existing;
        return this.createUnique(label || directory.replace(/\/$/, '').split(/[\\/]/).pop() || t('project.defaultName'), directory);
    }
    private async createUnique(base: string, directory?: string): Promise<ProjectFolder> {
        const folders = await this.navigationFolders();
        let name = base;
        for (let n = 2; folders.some(folder => folder.path === '/' + name); n++) name = `${base} (${n})`;
        return this.create(name, null, directory);
    }
    /** Compatibility entry point for callers that require a local default project. */
    async personal(): Promise<ProjectFolder> {
        const project = await this.defaultProjects.ensure();
        if (!project) throw new FSError('ENOENT', 'No local project is available as the default');
        return project;
    }
    async ensureStartup(directory?: string): Promise<void> {
        const explicit = directory ? await this.ensureDirectory(directory) : undefined;
        const existing = explicit ?? await this.defaultProjects.ensure();
        if (explicit) await this.defaultProjects.ensure();
        this.startupId = existing?.project.id;
        if (existing) await this.sessionFolder(existing);
    }
    async initializeSession(id: string): Promise<boolean> {
        const manifest = await this.repository.getManifest(id);
        const explicit = await this.forFolder(manifest.folder);
        let project = explicit ?? await this.current();
        if (!project && this.startupId) { await this.ensureStartup(); project = await this.current(); }
        if (!project) return false;
        const folder = explicit && manifest.folder !== project.path ? manifest.folder! : await this.folderInProject(project, explicit ? null : manifest.folder);
        await this.directories.setWorkspace(id, project.project.directory, this.workspaceAccess(project));
        if (folder !== manifest.folder) await this.repository.updateManifest(id, { folder });
        return true;
    }
    /** Called only after the host has acquired this Session's write lease. */
    async adoptSession(id: string, reconcileFolder?: (folder: string) => Promise<void>): Promise<void> {
        await this.sessionMoves.recoverLeased(id);
        const session = await this.repository.getManifest(id).catch(error => {
            if (error?.code === 'ENOENT') return undefined; throw error;
        });
        if (!session) return;
        await this.repository.relocateProjectStorage?.(id);
        const owned = await this.forFolder(session.folder);
        const grant = (await this.files.inspect(id))?.mounts.find(mount => mount.at === '/workspace');
        if (owned) {
            if (grant && (this.fileSource(owned).kind === 'remote' ? grant.sourceId !== owned.project.directory
                : this.directories.describe(grant) !== owned.project.directory))
                await this.directories.restoreWorkspace(id, owned.project.directory, this.workspaceAccess(owned, grant.access));
            return;
        }
        if (!grant) return;
        const directory = this.directories.describe(grant);
        const project = (await this.list()).find(item => item.project.directory.replace(/^host:/, '') === directory);
        if (!project) return;
        const folder = await this.folderInProject(project, session.folder);
        if (reconcileFolder) await reconcileFolder(folder);
        else await this.repository.updateManifest(id, { folder });
    }
    private async folderInProject(project: ProjectFolder, folder?: string | null): Promise<string> {
        let parent = await this.sessionFolder(project);
        for (const name of (folder ?? '').split('/').filter(Boolean)) {
            parent += '/' + name;
            await this.repository.createFolder(parent);
        }
        return parent;
    }
    async sessionFolder(project: ProjectFolder): Promise<string> {
        await this.drafts.ensure(project.project.id);
        const path = project.path + '/@sessions';
        await this.repository.createFolder(path);
        return path;
    }
    async openFiles(folder: string) {
        const catalog = await this.list(), project = catalog.find(item => item.path === folder);
        if (!project) throw new FSError('ENOENT', 'Project not found');
        return this.openProjectFiles(project, catalog);
    }
    private async openProjectFiles(project: ProjectFolder, catalog: readonly ProjectFolder[]) {
        await this.assertIndependent(project, this.remoteMounts?.list(project.project.id) ?? [], catalog);
        if (this.fileSource(project).kind === 'remote' && !this.remoteMounts?.list(project.project.id).some(mount => mount.at === '/'))
            throw new FSError('EACCES', t('project.error.remoteSourceMissing'));
        const open = () => this.directories.openDirectory(project.project.directory);
        return this.remoteMounts ? this.remoteMounts.compose(project.project.id, open) : open();
    }
    fileSource(project: ProjectFolder): ProjectFileSource {
        return projectFileSource(project, this.remoteMounts);
    }
    workspaceAccess(project: ProjectFolder, requested: 'ro' | 'rw' = 'rw'): 'ro' | 'rw' {
        return projectWorkspaceAccess(project, this.remoteMounts, requested);
    }
    async assertIndependent(project: ProjectFolder, mounts = this.remoteMounts?.list(project.project.id) ?? [], knownCatalog?: readonly ProjectFolder[]): Promise<void> {
        const catalog = knownCatalog ?? await this.list();
        const location = projectFileLocation(project, '/', mounts);
        const roots: ProjectFileRoot[] = catalog.filter(item => item.project.id !== project.project.id)
            .map(item => ({ projectId: item.project.id, name: item.name,
                location: projectFileLocation(item, '/', this.remoteMounts?.list(item.project.id) ?? []) }));
        const conflicts = overlappingProjectRoots(location, roots);
        if (!conflicts.length) return;
        throw Object.assign(new FSError('EACCES', t('project.error.rootOverlap', { project: project.name, projects: conflicts.map(item => item.name).join(', ') })),
            { reason: 'PROJECT_ROOT_OVERLAP', projectId: project.project.id, location, conflictingProjects: conflicts });
    }
    /**
     * Root capability of a project source view. The browser projection uses it for the
     * fixed Files entry without opening the canonical workspace view or its subscriptions.
     */
    async workspaceReadOnly(folder: string): Promise<boolean> {
        const source = await this.openFiles(folder);
        try { return (await source.fs.capabilitiesAt('/')).readonly; } finally { await source.dispose(); }
    }
    /** The editor and tools share canonical project paths; openFiles remains a source view. */
    async openWorkspace(folder: string) {
        const catalog = await this.list(), project = catalog.find(item => item.path === folder);
        if (!project) throw new FSError('ENOENT', 'Project not found');
        const source = await this.openProjectFiles(project, catalog);
        try {
            const fs = createFileSystemView({ viewId: `project-workspace:${source.fs.viewId}`, mounts: [
                { mountId: 'workspace', at: WORKSPACE_PATH, fs: source.fs, access: 'rw' },
            ] });
            const stop = trackFavoriteFiles(this.favorites, project.project.id, fs);
            return { fs, async dispose() { try { await stop(); } finally { try { await fs.dispose(); } finally { await source.dispose(); } } } };
        } catch (error) { await source.dispose(); throw error; }
    }
    async assertMove(from: string | null, to: string | null, projectRoot = false): Promise<void> {
        const [source, target] = await Promise.all([this.forFolder(from), this.forFolder(to)]);
        if (projectRoot ? !!target : source?.project.id !== target?.project.id) {
            throw new FSError('EACCES', t('project.error.moveAcross'));
        }
    }
}

import type { ProjectConversationPort } from '@itookit/app-contracts/services';
import { observeConversation } from './conversation-view';
import {prepareRemoteDraft, remoteConversationKey} from './drafts/remote-submission';
import {readConversationIdentity} from './drafts/remote-identity';
import { RemoteConversationStore } from './remote-conversation-store';
import {draftHarness, draftConversation, remoteConversationJournal} from './remote-draft-conversation';
import { RemoteSessionStatus } from '../session/remote-session-status';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import type { MCPDeletedProject, MCPDeletionReference } from '../configuration/model-commands';
import { MCPRemoteConnections, remoteMCPConnection } from './mcp-remote-connections';
import { RemoteConnectionUnavailableError, reportRemoteFailure, type MCPConnectionDiagnostic } from './remote-diagnostics';
import type { ExecutionCapabilities, ProjectExecutionContext } from './execution/contracts';
import { RemoteMountStore, type RemoteMountCatalog as Catalog } from './remote-mount-store';
import { randomUUID } from '@itookit/common';
import { checkOperation, createFileSystemView, FSError, normalizeVirtualPath, operationScope,
    type FileSystemSourceOwner, type FileSystemMount, type IFileSystem, type OperationOptions } from '@itookit/vfs-core';
import { createUnavailableDirectory } from '../vfs/unavailable-directory';
import { canReaddressConnection, normalizeConnection, remoteProjectPath, type RemoteFileSystemConfig, type RemoteFileSystemInput } from './remote-connections';
import type { HarnessClient } from '@itookit/piagent-driver/harness';
import type { ProjectClient, RemoteProject, HarnessConversationPort, HarnessProfile, HarnessConversationJournal } from '@itookit/piagent-driver';

export interface RemoteFileConnection { endpoint: string; alias: string; credentialRef: string; username?: string; anonymous?: boolean; authorization?: import('@itookit/piagent-driver').RemoteAuthorization; }

/** One directory grant as the execution node must expose it to a process. */
export interface RemoteProcessMount { alias: string; path: string; at: string; access: 'ro' | 'rw' }
/** Process request for one already-authorized workspace namespace (`serverId` + `epoch`). */
export interface RemoteProcessRequest {
    serverId: string;
    epoch: string;
    cwd: string;
    mounts: readonly RemoteProcessMount[];
}
export interface RemoteProcessHandle { nativeShell: NonNullable<ProjectExecutionContext['nativeShell']>; release(): Promise<void> }

export interface RemoteFileSourceProvider {
    observeHarness?(client: HarnessClient, writable?: boolean, options?: {watchFiles?: boolean}): import('@itookit/piagent-driver').HarnessStatusPort;
    conversation?(client: HarnessClient, profile: HarnessProfile, workspaceId: string, sessionId?: string, writable?: boolean, journal?: HarnessConversationJournal): HarnessConversationPort;
    resolveCredential?(reference: string): string | Promise<string>;
    discover?(connection: Omit<RemoteFileConnection, 'alias'>, options?: OperationOptions): Promise<import('@itookit/piagent-driver').PiAgentDescriptor>;
    projects?(connection: Omit<RemoteFileConnection, 'alias'>): ProjectClient;
    projectProcess?(connection: Omit<RemoteFileConnection, 'alias'>, project: RemoteProject, request: RemoteProcessRequest): Promise<RemoteProcessHandle>;
    harness?(connection: Omit<RemoteFileConnection, 'alias'>): HarnessClient;
    /** Optional process capability of the same node that serves files. */
    process?(connection: Omit<RemoteFileConnection, 'alias'>, request: RemoteProcessRequest): Promise<RemoteProcessHandle>;

    capabilities?(connection: Omit<RemoteFileConnection, 'alias'>, options?: OperationOptions): Promise<ExecutionCapabilities>;
    clearCredential?(reference: string): void;
    setCredential(reference: string, secret: string): void | (() => void);
    open(connection: RemoteFileConnection, options?: OperationOptions): Promise<FileSystemSourceOwner>;
    check?(connection: Omit<RemoteFileConnection, 'alias'>, options?: OperationOptions): Promise<void>;
    browse?(connection: Omit<RemoteFileConnection, 'alias'>, path: string, cursor?: string, options?: OperationOptions): Promise<{ paths: string[]; nextCursor: string | null }>;
    checkDraft?(connection: Omit<RemoteFileConnection, 'alias'>, password: string, options?: OperationOptions): Promise<void>;
    dispose(): Promise<void>;
}
export interface ProjectRemoteMount extends RemoteFileConnection {
    capabilities?: import('@itookit/piagent-driver').RemoteProjectCapabilities;
    serverProjectId?: string; serverProjectRevision?: number; serverId?: string; mountId: string; at: string; root: string; access: 'ro' | 'rw'; connectionId?: string;
}
export type RemoteConnectionStatus = 'unknown' | 'checking' | 'online' | 'offline';

/** Project-owned grants; credentials stay in the injected host provider. */
export class ProjectRemoteMountService {
    estimateUsage?: (usage: import('@itookit/piagent-driver').HarnessUsage) => import('@itookit/kernel-adapters/contracts').UsageCostEstimate;
    readonly sessionStatus = new RemoteSessionStatus(id => {
        const grants = this.list(id), root = grants.find(m => m.at === '/');
        return !this.closed && root?.connectionId && root.serverProjectId ? JSON.stringify(grants) : undefined;
    }, async (id, options) => {
        if (!this.provider.observeHarness) throw new FSError('ECAPABILITY', 'Harness observation unavailable');
        const client = await this.projectHarness(id, options), root = this.list(id).find(m => m.at === '/')!;
        return this.provider.observeHarness(this.guardHarness(client, id, JSON.stringify(this.list(id)), root.connectionId!), root.access === 'rw', {watchFiles: false});
    });
    inspectRemoteProjects?: (ids: readonly string[]) => Promise<MCPDeletedProject[]>;
    removeRemoteProjects?: (ids: readonly string[]) => Promise<void>;
    existingProjectIds?: () => Promise<readonly string[]>;
    rootValidator?: (projectId: string, mount: ProjectRemoteMount) => Promise<void>;
    private catalog: Catalog = { version: 1, revision: 0, projects: {} };
    private readonly views = new Map<string, Set<FileSystemSourceOwner>>();
    private readonly sources = new Map<string, Promise<FileSystemSourceOwner>>();
    private readonly missing = new Map<string, Promise<FileSystemSourceOwner>>();
    private tail: Promise<unknown> = Promise.resolve();
    private closed = false;
    private readonly catalogStore: RemoteMountStore;
    private readonly states = new Map<string, RemoteConnectionStatus>();
    private readonly connectionStates = new Map<string, RemoteConnectionStatus>();
    private readonly listeners = new Set<() => void>();
    private readonly probes = new Map<string, Promise<void>>();
    readonly diagnostics = new Map<string, string[]>();
    /** Entries dropped while loading the catalog, so a single bad record cannot block startup. */
    readonly loadWarnings: string[] = [];
    constructor(private readonly store: IFileSystem, private readonly provider: RemoteFileSourceProvider,
        private readonly beforeChange: (projectId: string) => Promise<void>,
        private readonly afterChange: (projectId: string) => Promise<void>, private readonly mcpConnections?: MCPRemoteConnections) { this.catalogStore = new RemoteMountStore(store); }
    async init(deferMCP = false): Promise<void> {
        const saved = await this.catalogStore.load();
        if (!saved) { if (!deferMCP) await this.mcpConnections?.refresh(); return; }
        if (!saved || saved.version !== 1 || (!Number.isSafeInteger(saved.revision) || saved.revision < 0) || !saved.projects || typeof saved.projects !== 'object') throw new FSError('EINVAL', 'Invalid remote mount catalog');
        // Validate per record: a single damaged entry must not stop the whole application from
        // starting, and the surviving grants stay usable.
        const connections = (Array.isArray(saved.connections) ? saved.connections : []).filter(connection => {
            try {
                normalizeConnection(connection);
                if (!/^[a-zA-Z0-9_-]{1,128}$/.test(connection.id) || !connection.credentialRef) throw new FSError('EINVAL', 'Invalid connection reference');
                return true;
            } catch { this.loadWarnings.push(`INVALID_CONNECTION:${(connection as { id?: string })?.id ?? 'unknown'}`); return false; }
        });
        if (connections.length || !deferMCP) await this.mcpConnections?.migrate(connections,id => this.catalogStore.password(id));
        const known = new Set([...connections, ...(this.mcpConnections?.list() ?? [])].map(connection => connection.id));
        const projects: Record<string, ProjectRemoteMount[]> = {};
        for (const [projectId, mounts] of Object.entries(saved.projects)) {
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId) || !Array.isArray(mounts)) { this.loadWarnings.push(`INVALID_PROJECT:${projectId}`); continue; }
            const valid = mounts.filter(mount => {
                try {
                    validateMount(mount);
                    if (mount.connectionId && !known.has(mount.connectionId) && !this.mcpConnections) throw new FSError('EINVAL', 'Missing remote connection');
                    return true;
                } catch { this.loadWarnings.push(`INVALID_MOUNT:${projectId}`); return false; }
            });
            if (valid.length) projects[projectId] = valid;
        }
        this.catalog = { ...saved, projects, connections };
        if (this.mcpConnections && (connections.length || this.catalogStore.needsMigration)) await this.persist({ ...this.catalog, connections: [] });
        else if (this.catalogStore.needsMigration) await this.persist(this.catalog);
        for (const connection of connections) {
            const password = this.catalogStore.password(connection.id);
            if (password) this.provider.setCredential(connection.credentialRef, password);
        }
    }
    async executionCapabilities(connectionId: string, options?: OperationOptions): Promise<ExecutionCapabilities> {
        if (!this.provider.capabilities) throw new FSError('ECAPABILITY', 'Remote capability discovery is unavailable');
        return this.provider.capabilities(await this.resolveConnection(connectionId, options), options);
    }
    mountedProjectIds(): string[] { return Object.keys(this.catalog.projects); }
    list(projectId: string): ProjectRemoteMount[] {
        return structuredClone((this.catalog.projects[projectId] ?? []).map(mount => {
            const connection = mount.connectionId && this.connections().find(item => item.id === mount.connectionId);
            if (connection) return { ...mount, endpoint:connection.endpoint, username:connection.username, credentialRef:connection.credentialRef,serverId:connection.serverId };
            return mount.connectionId && this.mcpConnections ? { ...mount, endpoint:'',credentialRef:'' } : mount;
        }));
    }
    connections(): RemoteFileSystemConfig[] { return this.mcpConnections?.list() ?? structuredClone(this.catalog.connections ?? []); }
    connectionName(id: string): string | undefined {
        return this.connections().find(connection => connection.id === id)?.name ?? this.mcpConnections?.diagnostic(id).connectionName;
    }
    connectionDiagnostic(id: string): MCPConnectionDiagnostic {
        if (this.mcpConnections) return this.mcpConnections.diagnostic(id);
        const configured = this.connections().map(connection => ({id: connection.id, name: connection.name, reason: 'ready' as const}));
        const connection = configured.find(connection => connection.id === id);
        return {connectionId: id, connectionName: connection?.name, reason: connection ? 'ready' : 'mcp-not-found',
            revision: this.catalog.revision, configured};
    }
    harness(connectionId: string): HarnessClient {
        if (!this.provider.harness) throw new FSError('ECAPABILITY', 'Harness access is unavailable');
        return this.provider.harness(this.connection(connectionId));
    }
    connection(id: string): RemoteFileSystemConfig {
        const connection = this.connections().find(item => item.id === id);
        if (!connection) {
            const error = new RemoteConnectionUnavailableError(this.connectionDiagnostic(id), this.connectionProjects(id));
            reportRemoteFailure(error, {stage: 'connection-lookup', connectionId: id});
            throw error;
        }
        return connection;
    }
    async resolveConnection(id: string, options?: OperationOptions): Promise<RemoteFileSystemConfig> {
        try { await this.mcpConnections?.ensure(id, options); return this.connection(id); }
        catch (error) {
            if (!options?.signal?.aborted) reportRemoteFailure(error, {stage: 'mcp-connection-recovery', connectionId: id});
            throw error;
        }
    }
    async checkConnection(id: string, options?: OperationOptions): Promise<void> {
        let connection: RemoteFileSystemConfig;
        try { connection = await this.resolveConnection(id, options); }
        catch (error) { if (options?.signal?.aborted) return; throw error; }
        const projects = this.connectionProjects(id), previous = this.connectionStatus(id);
        this.setConnectionStatus(id, 'checking');
        let handshakeFailed = false;
        try {
            if (this.provider.check) await this.provider.check(connection, options);
            else if (!projects.length) throw new FSError('ECAPABILITY', 'Connection checks unavailable');
        } catch { handshakeFailed = !options?.signal?.aborted; }
        if (options?.signal?.aborted) { this.setConnectionStatus(id, previous); return; }
        // Probe the mounts either way: a failed handshake must not pin a reachable connection to
        // offline, and the mounts' own probes are what the workbench availability state derives from.
        if (projects.length) await Promise.all(projects.map(projectId => this.checkConnections(projectId, options)));
        if (options?.signal?.aborted) { this.setConnectionStatus(id, previous); return; }
        const offline = projects.some(projectId => this.projectOffline(projectId)) || (handshakeFailed && !projects.length);
        this.setConnectionStatus(id, offline ? 'offline' : 'online');
    }
    async checkDraft(input: RemoteFileSystemInput, password: string, id?: string, options?: OperationOptions): Promise<void> {
        const value = normalizeConnection(input);
        const credentialRef = id ? this.connection(id).credentialRef : '';
        if (!this.provider.checkDraft) throw new FSError('ECAPABILITY', 'Connection checks unavailable');
        await this.provider.checkDraft({ ...value, credentialRef }, password, options);
    }
    async browseDirectories(id: string, path: string, cursor?: string, options?: OperationOptions) {
        if (!this.provider.browse) throw new FSError('ECAPABILITY', 'Directory browsing unavailable');
        const normalized = path === '/' ? '/' : (() => { const { alias, root } = remoteProjectPath(path); return `/${alias}${root === '/' ? '' : root}`; })();
        return this.provider.browse(await this.resolveConnection(id, options), normalized, cursor, options);
    }
    saveConnection(input: RemoteFileSystemInput, password: string, id?: string): Promise<string> {
        return this.serial(async () => {
            const value = normalizeConnection(input), existing = id ? this.connection(id) : undefined;
            if (!existing && !password) throw new FSError('EINVAL', 'Password required');
            const connections = this.connections();
            if (connections.some(item => item.id !== id && (item.name === value.name || (item.endpoint === value.endpoint && item.username === value.username))))
                throw new FSError('EEXIST', 'Remote file system already configured');
            const affected = this.connectionProjects(id);
            if (affected.length && existing?.endpoint !== value.endpoint) throw new FSError('EBUSY', 'Referenced endpoint cannot change');
            for (const projectId of affected) await this.beforeChange(projectId);
            const next = { ...value, id: id ?? randomUUID(), credentialRef: existing?.credentialRef ?? randomUUID() };
            const restore = password ? this.provider.setCredential(next.credentialRef, password) : undefined;
            try {
                if (this.mcpConnections) await this.mcpConnections.save(value,password,next.id,next.credentialRef);
                else await this.persist({ ...this.catalog,connections:[...connections.filter(item => item.id !== id),next] },password ? {id:next.id,password} : undefined);
            }
            catch (error) { restore?.(); throw error; }
            for (const projectId of affected) {
                await this.changed(projectId);
                for (const mount of this.list(projectId).filter(item => item.connectionId === id)) await this.releaseSource(mount.mountId);
                await this.checkConnections(projectId, { timeoutMs: 3000 });
            }
            for (const listener of this.listeners) listener();
            return next.id;
        });
    }
    removeConnection(id: string): Promise<void> {
        return this.serial(async () => {
            if (this.connectionProjects(id).length) throw new FSError('EBUSY', 'Remote file system is referenced by projects');
            const credentialRef = this.connection(id).credentialRef;
            if (this.mcpConnections) await this.mcpConnections.remove(id);
            else await this.persist({ ...this.catalog, connections:this.connections().filter(item => item.id !== id) });
            this.provider.clearCredential?.(credentialRef);
            this.connectionStates.delete(id);
            for (const listener of this.listeners) listener();
        });
    }
    async beforeMCPChange(server: MCPServer, previous?: MCPServer): Promise<void> {
        if (!previous || !this.connectionProjects(server.id).length) return;
        const before = remoteMCPConnection(previous), after = remoteMCPConnection(server);
        if (!before && after && this.recoversMCP(server, previous, after)) return;
        const legacyCredentialUnchanged = !!previous.apiKey && previous.apiKey === server.apiKey
            && JSON.stringify(previous.headers) === JSON.stringify(server.headers);
        if (!before || !after || before.endpoint !== after.endpoint && !canReaddressConnection(before, after, legacyCredentialUnchanged)
            || before.username !== after.username || before.credentialRef !== after.credentialRef || before.anonymous !== after.anonymous
            || !!before.authorization && before.authorization.principalId !== after.authorization?.principalId
            || !!before.serverId && before.serverId !== after.serverId)
            throw new FSError('EBUSY', 'Referenced pi-agent connection cannot be retargeted or disabled');
        if (before.endpoint !== after.endpoint || JSON.stringify(previous.auth) !== JSON.stringify(server.auth) || previous.apiKey !== server.apiKey)
            for (const id of this.connectionProjects(server.id)) await this.beforeChange(id);
    }
    private recoversMCP(server: MCPServer, previous: MCPServer, after: RemoteFileSystemConfig): boolean {
        if (server.transport !== previous.transport || server.endpoint !== previous.endpoint || server.apiKey !== previous.apiKey
            || JSON.stringify(server.auth) !== JSON.stringify(previous.auth) || JSON.stringify(server.headers) !== JSON.stringify(previous.headers)) return false;
        const mounts = Object.values(this.catalog.projects).flat().filter(mount => mount.connectionId === server.id);
        return mounts.length > 0 && mounts.every(mount => mount.endpoint === after.endpoint && mount.username === after.username
            && mount.credentialRef === after.credentialRef && (!mount.serverId || mount.serverId === after.serverId));
    }
    beforeMCPDelete(id: string): void {
        if (this.connectionProjects(id).length) throw new FSError('EBUSY', 'MCP configuration is referenced by remote projects');
    }
    reconcileMCPReferences(): Promise<void> {
        return this.serial(async () => {
            if (!this.existingProjectIds) return;
            const existing = new Set(await this.existingProjectIds());
            // Root grants belong to explicit remote identities, independent of server availability.
            // Attached mounts on local projects may be temporarily unavailable and are retained.
            const missing = Object.keys(this.catalog.projects).filter(id => !existing.has(id)
                && this.list(id).some(mount => mount.at === '/'));
            if (!missing.length) return;
            const projects = {...this.catalog.projects}, mounts = missing.flatMap(id => projects[id]);
            for (const id of missing) delete projects[id];
            await this.persist({...this.catalog,projects});
            for (const mount of mounts) await this.releaseSource(mount.mountId);
            for (const id of missing) { this.diagnostics.delete(id); await this.changed(id); }
        });
    }
    mcpReferences(ids: readonly string[]): MCPDeletionReference[] {
        return Object.entries(this.catalog.projects).flatMap(([projectId,mounts]) => mounts
            .filter(mount => !!mount.connectionId && ids.includes(mount.connectionId))
            .map(mount => ({connectionId:mount.connectionId!,projectId,mountId:mount.mountId,at:mount.at,revision:this.catalog.revision})))
            .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    removeMCPReferences(ids: readonly string[], expected: readonly MCPDeletionReference[], projectIds: readonly string[] = []): Promise<void> {
        return this.serial(async () => {
            const references = this.mcpReferences(ids);
            if (JSON.stringify(references) !== JSON.stringify(expected)) throw new FSError('EBUSY', 'Remote references changed; review deletion again');
            if (projectIds.some(id => !references.some(ref => ref.projectId === id && ref.at === '/')) || projectIds.length && !this.removeRemoteProjects)
                throw new FSError('EINVAL','Invalid remote project deletion');
            const affected = [...new Set(references.map(item => item.projectId))];
            const removed = affected.flatMap(id => this.catalog.projects[id].filter(mount => projectIds.includes(id) || !!mount.connectionId && ids.includes(mount.connectionId)));
            for (const id of affected) await this.beforeChange(id);
            if (projectIds.length) await this.removeRemoteProjects!(projectIds);
            const projects = {...this.catalog.projects};
            for (const id of affected) projects[id] = projectIds.includes(id) ? [] : projects[id].filter(mount => !mount.connectionId || !ids.includes(mount.connectionId));
            await this.persist({...this.catalog,projects});
            for (const mount of removed) await this.releaseSource(mount.mountId);
            for (const id of affected) await this.changed(id);
        });
    }
    async refreshMCPConnections(): Promise<void> {
        if (!this.mcpConnections || this.closed) return;
        const before = new Map(this.connections().map(item => [item.id,JSON.stringify([item.endpoint,item.username,item.credentialRef,item.anonymous,item.authorization])]));
        await this.mcpConnections.refresh();
        for (const projectId of Object.keys(this.catalog.projects)) {
            const mounts = this.list(projectId).filter(mount => mount.connectionId && before.get(mount.connectionId)
                !== (() => { const next = this.connections().find(item => item.id === mount.connectionId); return next ? JSON.stringify([next.endpoint,next.username,next.credentialRef,next.anonymous,next.authorization]) : undefined; })());
            for (const mount of mounts) await this.releaseSource(mount.mountId);
            if (mounts.length) await this.changed(projectId);
        }
        for (const listener of this.listeners) listener();
    }
    setMCPCredential(reference: string, password: string): void | (() => void) { return this.provider.setCredential(reference,password); }
    async discoverMCP(endpoint: string, username: string | undefined, credentialRef: string, options?: OperationOptions) {
        if (!this.provider.discover) throw new FSError('ECAPABILITY', 'pi-agent discovery unavailable');
        return this.provider.discover({endpoint,username,credentialRef},options);
    }
    forgetProject(projectId: string): Promise<void> {
        return this.serial(async () => {
            const mounts = this.list(projectId);
            if (!mounts.length) return;
            await this.beforeChange(projectId);
            const projects = { ...this.catalog.projects }; delete projects[projectId];
            await this.persist({ ...this.catalog, projects });
            await this.changed(projectId);
            this.diagnostics.delete(projectId);
            for (const mount of mounts) await this.releaseSource(mount.mountId);
        });
    }
    private connectionProjects(id?: string): string[] {
        return id ? Object.keys(this.catalog.projects).filter(project => this.list(project).some(mount => mount.connectionId === id)) : [];
    }
    private async releaseSource(id: string): Promise<void> {
        const source = this.sources.get(id); this.sources.delete(id); this.states.delete(id);
        await (await source?.catch(() => undefined))?.dispose();
    }
    findRemoteProject(connectionId: string, path: string): string | undefined {
        const connection = this.connection(connectionId), { alias, root } = remoteProjectPath(path);
        // Identity is part of the key: the same path under a different account is a different grant,
        // never a silent reuse of another user's project.
        return Object.keys(this.catalog.projects).find(id => this.list(id).some(mount => mount.at === '/'
            && (mount.endpoint === connection.endpoint || !!connection.serverId && mount.serverId === connection.serverId) && mount.username === connection.username
            && mount.alias === alias && mount.root === root));
    }
    bindProject(projectId: string, connectionId: string, path: string, access: 'ro' | 'rw', options?: OperationOptions & {createDirectory?: boolean; projectName?: string}): Promise<void> {
        return this.serial(async () => {
            if (this.findRemoteProject(connectionId, path)) throw new FSError('EEXIST', 'Remote path already belongs to a project');
            await this.beforeChange(projectId); checkOperation(options);
            const connection = this.connection(connectionId);
            const mount: ProjectRemoteMount = { endpoint: connection.endpoint, username: connection.username, anonymous:connection.anonymous, authorization:connection.authorization, credentialRef: connection.credentialRef,serverId:connection.serverId,
                connectionId, ...remoteProjectPath(path), access, at: '/', mountId: randomUUID() };
            await this.rootValidator?.(projectId, mount);
            const grants=[mount];
            if (connection.projects && this.provider.projects) {
                const client=this.provider.projects(connection);
                try {
                    const remote=await client.register({name:options?.projectName ?? projectId,alias:mount.alias,path:mount.root.replace(/^\//,''),access,createDirectory:options?.createDirectory},options);
                    if (remote.alias!==mount.alias || remote.path!==mount.root.replace(/^\//,'') || access==='rw' && remote.access!=='rw') throw new FSError('EACCES','Server project grant does not match the requested root');
                    mount.serverProjectId=remote.id; mount.serverProjectRevision=remote.revision;
                    mount.capabilities=remote.capabilities ? {...remote.capabilities,fileWrite:remote.capabilities.fileWrite && access==='rw'} : undefined;
                    for (const extra of remote.mounts) {
                        if (!extra.at.startsWith('/workspace/')) throw new FSError('EACCES','Server project mount outside the project');
                        const grant={...mount,alias:extra.alias,root:extra.path ? '/'+extra.path : '/',at:extra.at.slice('/workspace'.length),access:access==='ro' ? 'ro' as const : extra.access,mountId:randomUUID()};
                        validateMount(grant); grants.push(grant);
                    }
                } finally {await client.close();}
            } else if (options?.createDirectory) throw new FSError('ECAPABILITY','Server project creation is unavailable');
            const owner = await this.provider.open(mount, options);
            try {
                if ((await owner.fs.driver.getNode(mount.root, options))?.type !== 'directory') throw new FSError('ENOTDIR', 'Remote project path must be a directory');
                if (access === 'rw' && (await owner.fs.capabilitiesAt(mount.root, options)).readonly) throw new FSError('EROFS', 'Source is read-only');
                checkOperation(options); await this.save(projectId, grants);
            } catch (error) { await owner.dispose(); throw error; }
            this.sources.set(mount.mountId, Promise.resolve(owner)); this.setStatus(mount.mountId, 'online');
            await this.changed(projectId);
        });
    }
    async projectHarness(projectId: string, options?: OperationOptions): Promise<HarnessClient> {
        const mount=this.list(projectId).find(mount => mount.at==='/');
        if (!mount?.connectionId || !this.provider.projects) throw new FSError('ECAPABILITY','Project harness unavailable');
        const client=this.provider.projects(await this.resolveConnection(mount.connectionId, options));
        try {
            const project=mount.serverProjectId ? await client.read(mount.serverProjectId,options)
                : await client.register({name:projectId,alias:mount.alias,path:mount.root.replace(/^\//,''),access:mount.access},options);
            this.assertProjectGrant(projectId, mount, project);
            const harness=client.harness(project,{readOnly:mount.access==='ro'}), close=harness.close.bind(harness);
            harness.close=async () => {try {await close();}finally{await client.close();}};
            return harness;
        } catch(error) {await client.close();throw error;}
    }
    remountProject(projectId: string, access: 'ro' | 'rw', options?: OperationOptions): Promise<void> {
        return this.serial(async () => {
            if (!['ro', 'rw'].includes(access)) throw new FSError('EINVAL', 'Invalid project access');
            checkOperation(options); await this.beforeChange(projectId);
            const grants = this.list(projectId), root = grants.find(mount => mount.at === '/');
            if (!root?.connectionId || !root.serverProjectId || !this.provider.projects) throw new FSError('ECAPABILITY', 'Project remount unavailable');
            const client = this.provider.projects(await this.resolveConnection(root.connectionId, options));
            try {
                let project = await client.read(root.serverProjectId, options);
                this.assertProjectGrant(projectId, root, project);
                if (access === 'rw' && !(await client.roots(options)).roots.some(item => item.alias === root.alias && item.access === 'rw'))
                    throw new FSError('EROFS', 'Server export is read-only');
                if (access === 'rw' && project.access !== 'rw') {
                    if (!client.remount) throw new FSError('ECAPABILITY', 'Server project remount unavailable');
                    project = await client.remount(project, access, options);
                    this.assertProjectGrant(projectId, root, project);
                    if (project.access !== access) throw new FSError('EACCES', 'Server project access unavailable');
                }
                checkOperation(options);
                const next = grants.map(mount => ({...mount, mountId: randomUUID(), serverProjectRevision: project.revision,
                    authorization:project.authorization ?? mount.authorization,
                    capabilities:project.capabilities ? {...project.capabilities,fileWrite:project.capabilities.fileWrite && access==='rw'} : undefined,
                    access: access === 'ro' ? 'ro' as const : mount.at === '/' ? 'rw' as const
                        : project.mounts.find(item => item.at === '/workspace' + mount.at)!.access}));
                await this.save(projectId, next);
                try { await this.changed(projectId); }
                finally { await this.releaseSources(grants); }
            } finally { await client.close(); }
        });
    }
    private async releaseSources(grants: readonly ProjectRemoteMount[]): Promise<void> {
        await Promise.all(grants.map(mount => this.releaseSource(mount.mountId)));
    }
    private assertProjectGrant(projectId: string, mount: ProjectRemoteMount, project: RemoteProject): void {
            if (mount.serverProjectId && project.id !== mount.serverProjectId || project.alias!==mount.alias || project.path!==mount.root.replace(/^\//,'')) throw new FSError('ECONFLICT','Project directory changed');
            const expected=[{alias:project.alias,root:project.path ? '/'+project.path : '/',at:'/'},...project.mounts.map(m=>({alias:m.alias,root:m.path ? '/'+m.path : '/',at:m.at.slice('/workspace'.length)}))];
            const granted=this.list(projectId);
            if (expected.length!==granted.length || expected.some(m=>!granted.some(g=>g.alias===m.alias && g.root===m.root && g.at===m.at)) || mount.access==='rw' && project.mounts.some(m=>granted.find(g=>g.at===m.at.slice('/workspace'.length))?.access!==m.access)) throw new FSError('ECONFLICT','Server project mounts changed; refresh the project binding');
    }
    async searchFiles(projectId: string, query: import('@itookit/piagent-driver').FileSearchQuery, options?: OperationOptions) {
        const mount = this.list(projectId).find(m => m.at === '/');
        if (!mount?.connectionId || !mount.serverProjectId || !this.provider.projects) throw new FSError('ECAPABILITY', 'Project search unavailable');
        const fingerprint = JSON.stringify(this.list(projectId));
        const connection = await this.resolveConnection(mount.connectionId, options);
        const client = this.provider.projects(connection);
        try {
            const project = await client.read(mount.serverProjectId, options);
            if (!client.search) throw new FSError('ECAPABILITY', 'Server file search unavailable');
            if (project.revision !== mount.serverProjectRevision) throw new FSError('ECONFLICT', 'Project search revision changed');
            this.assertProjectGrant(projectId, mount, project);
            const result = await client.search(project, query, options);
            if (this.closed || fingerprint !== JSON.stringify(this.list(projectId))) throw new FSError('ECONFLICT', 'Project authorization changed');
            return result;
        } finally { await client.close(); }
    }
    async projectModels(projectId: string, profileId: string, options?: OperationOptions): Promise<import('@itookit/piagent-driver').HarnessModelCatalog> {
        const client = await this.projectHarness(projectId, options);
        const fingerprint = JSON.stringify(this.list(projectId));
        try {
            const descriptor = await client.profiles(options);
            const profile = descriptor.profiles.find(profile => (profile.id === profileId || profile.aliases?.includes(profileId)) && profile.projectRuntime && profile.capabilities.create);
            if (!profile) throw new FSError('ECAPABILITY', 'Project harness profile unavailable');
            if (!profile.capabilities.models || !client.models) return {models: []};
            const root = this.list(projectId).find(mount => mount.at === '/')!;
            return await this.guardHarness(client, projectId, fingerprint, root.connectionId!).models!(profile.id, undefined, options);
        } finally {await client.close();}
    }
    async projectConversation(projectId: string, profileId: string, sessionId?: string, options?: OperationOptions, readOnly = false, draftId?: string): Promise<ProjectConversationPort> {
        if (draftId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(draftId)) throw new FSError('EINVAL', 'Invalid draft identity');
        if (!this.provider.conversation) throw new FSError('ECAPABILITY', 'Conversation adapter unavailable');
        const client = await this.projectHarness(projectId, options);
        const fingerprint = JSON.stringify(this.list(projectId));
        try {
            const descriptor = await client.profiles(options);
            const profile = descriptor.profiles.find(p => (p.id === profileId || p.aliases?.includes(profileId)) && p.projectRuntime);
            if (!profile) throw new FSError('ECAPABILITY', 'Project harness profile unavailable');
            const root = this.list(projectId).find(m => m.at === '/')!;
            const conversationId = sessionId ? await readConversationIdentity(this.store, projectId, {
                connectionId: root.connectionId!, serverProjectId: root.serverProjectId!, principalId: root.authorization?.principalId,
                profileId: profile.id, nativeSessionId: sessionId}) : draftId;
            const target = {connectionId: root.connectionId!, serverProjectId: root.serverProjectId!,
                ...(root.authorization ? {principalId: root.authorization.principalId} : {}), profileId: conversationId ? profile.id : profileId};
            if (draftId) await prepareRemoteDraft(this.store, projectId, draftId, target);
            const guarded = this.guardHarness(client, projectId, fingerprint, root.connectionId!);
            const recovery = new RemoteConversationStore(this.store, remoteConversationKey(projectId, target, conversationId ?? sessionId ?? '@new'));
            const conversation = await this.provider.conversation(sessionId ? guarded : draftHarness(guarded, recovery), profile, profile.workspaces[0].id, sessionId, (profile.projectCapabilities?.sessionControl ?? root.access === 'rw') && !readOnly,
                remoteConversationJournal(recovery, descriptor.epoch, !sessionId && !draftId));
            return observeConversation(sessionId ? conversation : draftConversation(conversation, recovery), this.estimateUsage, conversationId,
                () => { void this.sessionStatus.refresh(projectId); });
        } catch (error) { await client.close(); throw error; }
    }
    private guardHarness(client: HarnessClient, projectId: string, fingerprint: string, connectionId: string): HarnessClient {
        return new Proxy(client, {get: (target, key) => {
            const value = Reflect.get(target, key);
            if (key === 'close' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
                try {
                    if (this.closed || fingerprint !== JSON.stringify(this.list(projectId))) throw new FSError('ECONFLICT', 'Project authorization changed');
                    this.connection(connectionId); return await value.apply(target, args);
                } catch (error) {
                    reportRemoteFailure(error, {stage: `harness.${String(key)}`, projectId, connectionId,
                        ...(typeof args[0] === 'string' ? {profileId: args[0]} : {}),
                        ...(['resume', 'turn', 'read', 'inspect'].includes(String(key)) && typeof args[1] === 'string' ? {sessionId: args[1]} : {})});
                    throw error;
                }
            };
        }});
    }
    projectOffline(projectId: string): boolean { return this.list(projectId).some(mount => this.status(mount.mountId) === 'offline'); }
    /** A project whose mounts shadow each other or lost a source; it stays usable and reports why. */
    degraded(projectId: string): boolean { return (this.diagnostics.get(projectId)?.length ?? 0) > 0; }
    status(mountId: string): RemoteConnectionStatus { return this.states.get(mountId) ?? 'unknown'; }
    connectionStatus(id: string): RemoteConnectionStatus { return this.connectionStates.get(id) ?? 'unknown'; }
    /** Read-only precheck for destructive callers: fails while any affected Session is busy. */
    async assertUnmountable(projectId: string): Promise<void> { await this.beforeChange(projectId); }
    onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    async checkConnections(projectId: string, options?: OperationOptions): Promise<void> {
        if (this.closed) return;
        await Promise.all(this.list(projectId).map(mount => this.probe(mount, options)));
    }
    private probe(mount: ProjectRemoteMount, options?: OperationOptions): Promise<void> {
        const pending = this.probes.get(mount.mountId); if (pending) return pending;
        const previous = this.status(mount.mountId);
        if (previous === 'unknown') this.setStatus(mount.mountId, 'checking');
        const work = (async () => {
            // One budget for opening and probing: a 3s check must not spend 3s per step.
            const scope = operationScope({ timeoutMs: 3000, ...options });
            try {
                checkOperation(scope.options);
                const source = await this.resolve(mount, scope.options);
                if ((await source.fs.driver.getNode(mount.root, scope.options))?.type !== 'directory') throw new FSError('ENOTDIR', 'Remote root unavailable');
                this.setStatus(mount.mountId, 'online');
            } catch {
                this.setStatus(mount.mountId, scope.options.signal?.aborted ? previous : 'offline');
            } finally { scope.dispose(); this.probes.delete(mount.mountId); }
        })();
        this.probes.set(mount.mountId, work); return work;
    }
    private setStatus(id: string, status: RemoteConnectionStatus) {
        if (this.status(id) === status || this.closed) return;
        this.states.set(id, status); for (const listener of this.listeners) listener();
    }
    private setConnectionStatus(id: string, status: RemoteConnectionStatus) {
        if (this.connectionStatus(id) === status || this.closed) return;
        this.connectionStates.set(id, status); for (const listener of this.listeners) listener();
    }
    add(projectId: string, input: Omit<ProjectRemoteMount, 'mountId' | 'credentialRef' | 'access'> & { access?: 'ro' | 'rw' },
        secret: string, base: IFileSystem, options?: OperationOptions): Promise<void> {
        return this.serial(async () => {
            checkOperation(options); await this.beforeChange(projectId);
            const id = randomUUID(), mount: ProjectRemoteMount = { ...input, mountId: id, credentialRef: id, access: input.access ?? 'ro' };
            validateMount(mount);
            if (mount.at === '/') await this.rootValidator?.(projectId, mount);
            if (this.list(projectId).some(item => item.at === mount.at) || await base.driver.exists(mount.at, options)) throw new FSError('EEXIST', 'MOUNT_POINT_CONFLICT');
            const restore = this.provider.setCredential(id, secret);
            let owner: FileSystemSourceOwner;
            try { owner = await this.provider.open(mount, options); }
            catch (error) { restore?.(); throw error; }
            try {
                if (mount.access === 'rw' && (await owner.fs.capabilitiesAt(mount.root, options)).readonly) throw new FSError('EROFS', 'Source is read-only');
                if ((await owner.fs.driver.getNode(mount.root, options))?.type !== 'directory') throw new FSError('ENOTDIR', 'Remote mount root must be a directory');
                checkOperation(options);
                await this.save(projectId, [...this.list(projectId), mount]);
                this.sources.set(id, Promise.resolve(owner));
                this.setStatus(id, 'online');
            } catch (error) { restore?.(); await owner.dispose(); throw error; }
            await this.changed(projectId);
        });
    }
    remove(projectId: string, mountId: string): Promise<void> {
        return this.serial(async () => {
            await this.beforeChange(projectId);
            await this.save(projectId, this.list(projectId).filter(item => item.mountId !== mountId));
            await this.changed(projectId);
            const owner = this.sources.get(mountId); this.sources.delete(mountId);
            this.states.delete(mountId);
            await (await owner)?.dispose();
        });
    }
    reconnect(projectId: string, mountId: string, secret: string, options?: OperationOptions): Promise<void> {
        return this.serial(async () => {
            await this.beforeChange(projectId);
            const mount = this.list(projectId).find(item => item.mountId === mountId);
            if (!mount) throw new FSError('ENOENT', 'Remote mount not found');
            const restore = this.provider.setCredential(mount.credentialRef, secret);
            let next: FileSystemSourceOwner;
            try { next = await this.provider.open(mount, options); }
            catch (error) { restore?.(); throw error; }
            const old = this.sources.get(mountId);
            try {
                if ((await next.fs.driver.getNode(mount.root, options))?.type !== 'directory') throw new FSError('ENOTDIR', 'Remote mount root unavailable');
                checkOperation(options);
            } catch (error) { restore?.(); await next.dispose(); throw error; }
            this.sources.set(mountId, Promise.resolve(next));
            this.setStatus(mountId, 'online');
            // The replaced source is released even when view invalidation fails, or repeated
            // reconnects would leak a live remote connection each time.
            try { await this.changed(projectId); } finally { await (await old)?.dispose(); }
        });
    }
    async compose(projectId: string, input: FileSystemSourceOwner | (() => Promise<FileSystemSourceOwner>)): Promise<FileSystemSourceOwner> {
        const revision = this.catalog.revision;
        const definitions = this.list(projectId), remoteRoot = definitions.some(mount => mount.at === '/');
        const base = typeof input === 'function' ? remoteRoot ? undefined : await input() : input;
        if (!definitions.length) return base!;
        const mounts: FileSystemMount[] = remoteRoot ? [] : [{ mountId: 'primary', at: '/', fs: base!.fs, access: 'rw' }];
        const diagnostics: string[] = [];
        try {
            for (const mount of definitions) {
                if (base && mount.at !== '/' && await base.fs.driver.exists(mount.at)) diagnostics.push(`MOUNT_SHADOW_CONFLICT:${mount.at}`);
                const source = await (this.status(mount.mountId) === 'offline' ? Promise.reject(new FSError('EIO', 'Source unavailable')) : this.resolve(mount))
                    .catch(() => { this.setStatus(mount.mountId, 'offline'); diagnostics.push(`SOURCE_UNAVAILABLE:${mount.at}`); return this.unavailable(mount.mountId); });
                mounts.push({ ...mount, fs: this.statusView(mount, source.fs), root: mount.root });
            }
            if (this.closed || revision !== this.catalog.revision) throw new FSError('EBUSY', 'Project mounts changed while opening');
            this.diagnostics.set(projectId, diagnostics);
            const fs = createFileSystemView({ viewId: `project:${projectId}`, revision: this.catalog.revision, mounts });
            let closing: Promise<void> | undefined;
            const owner = { fs, dispose: () => closing ??= (async () => {
                this.views.get(projectId)?.delete(owner); await fs.dispose(); await base?.dispose();
            })() };
            if (!this.views.has(projectId)) this.views.set(projectId, new Set());
            this.views.get(projectId)!.add(owner); return owner;
        } catch (error) { await base?.dispose(); throw error; }
    }
    async dispose(): Promise<void> {
        await this.sessionStatus.dispose();
        this.closed = true; await this.tail.catch(() => {});
        await Promise.allSettled(this.probes.values());
        await Promise.all([...this.views.values()].flatMap(views => [...views].map(owner => owner.dispose())));
        await Promise.all([...this.sources.values(), ...this.missing.values()].map(async value => (await value.catch(() => undefined))?.dispose()));
        this.sources.clear(); this.missing.clear(); this.listeners.clear(); this.states.clear(); this.connectionStates.clear(); await this.provider.dispose();
    }
    private async changed(projectId: string) {
        await Promise.all([...(this.views.get(projectId) ?? [])].map(owner => owner.dispose()));
        await this.afterChange(projectId);
        for (const listener of this.listeners) listener();
    }
    private statusView(mount: ProjectRemoteMount, fallback: IFileSystem): IFileSystem {
        const current = async () => (await this.sources.get(mount.mountId))?.fs ?? fallback;
        const driver = new Proxy(fallback.driver, { get: (_target, key) => {
            if (typeof key !== 'string' || typeof (fallback.driver as any)[key] !== 'function') return (fallback.driver as any)[key];
            if (key === 'on' || key === 'onAny') return (fallback.driver as any)[key].bind(fallback.driver);
            return async (...args: any[]) => {
                if (this.status(mount.mountId) === 'offline') {
                    const path = typeof args[0] === 'string' ? normalizeVirtualPath(args[0]) : '';
                    const ancestor = path === '/' || path === mount.root || mount.root.startsWith(path + '/');
                    if (ancestor && ['getNode', 'getNodeType', 'exists'].includes(key)) {
                        if (key === 'exists') return true;
                        return { type: 'directory', path, parentPath: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
                            name: path.split('/').pop() ?? '', version: 0, createdAt: 0, modifiedAt: 0, tags: [], metadata: { unavailable: true } };
                    }
                    throw new FSError('EIO', 'Remote source unavailable');
                }
                try { const fs = await current(); return await (fs.driver as any)[key](...args); }
                catch (error) {
                    let cause = error;
                    for (let depth = 0; depth < 16 && cause instanceof FSError; depth++, cause = cause.cause) {
                        if (cause.operation === 'connect') { this.setStatus(mount.mountId, 'offline'); break; }
                    }
                    throw error;
                }
            };
        } });
        return new Proxy(fallback, { get: (target, key) => {
            if (key === 'driver') return driver;
            if (key === 'capabilitiesAt') return async (path: string, options?: OperationOptions) => {
                const caps = await (await current()).capabilitiesAt(path, options);
                return { ...caps, readonly: this.status(mount.mountId) === 'offline' || caps.readonly };
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
    private resolve(mount: ProjectRemoteMount, options?: OperationOptions) {
        if (mount.connectionId) {
            const current = this.connections().find(c => c.id === mount.connectionId);
            if (mount.authorization && (current?.authorization?.principalId !== mount.authorization.principalId
                || current.authorization.revision !== mount.authorization.revision)) return Promise.reject(new FSError('EACCES','Remote authorization changed; refresh the project binding'));
        }
        let owner = this.sources.get(mount.mountId);
        if (!owner) {
            owner = this.provider.open(mount, options); this.sources.set(mount.mountId, owner);
            void owner.catch(() => { if (this.sources.get(mount.mountId) === owner) this.sources.delete(mount.mountId); });
        }
        return owner;
    }
    private unavailable(id: string) {
        if (!this.missing.has(id)) this.missing.set(id, createUnavailableDirectory(id));
        return this.missing.get(id)!;
    }
    private async save(projectId: string, mounts: ProjectRemoteMount[]) {
        await this.persist({ ...this.catalog, projects: { ...this.catalog.projects, [projectId]: mounts } });
    }
    private async persist(catalog: Catalog, credential?: { id: string; password: string }) {
        const next = { ...catalog, revision: this.catalog.revision + 1 };
        await this.catalogStore.save(next, credential);
        this.catalog = next;
    }

    private serial<T>(action: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new FSError('EACCES', 'Remote mounts closed'));
        const pending = this.tail.catch(() => {}).then(() => { if (this.closed) throw new FSError('EACCES', 'Remote mounts closed'); return action(); });
        this.tail = pending; return pending;
    }
}

function validateMount(mount: ProjectRemoteMount): void {
    if (mount?.serverProjectId !== undefined && (!/^[a-zA-Z0-9_-]{1,128}$/.test(mount.serverProjectId) || !Number.isSafeInteger(mount.serverProjectRevision) || mount.serverProjectRevision!<1)) throw new FSError('EINVAL','Invalid server project reference');
    if (!mount || !['ro', 'rw'].includes(mount.access) || typeof mount.mountId !== 'string' || typeof mount.credentialRef !== 'string'
        || !(mount.at === '/' && mount.connectionId || /^\/[a-zA-Z0-9_-]+$/.test(mount.at)) || ['attachments', 'etc', 'var', 'dev', 'run', 'history', 'session'].includes(mount.at.slice(1))) throw new FSError('EINVAL', 'Invalid remote mount');
    normalizeVirtualPath(mount.root);
    const url = new URL(mount.endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !/^[a-zA-Z0-9_-]+$/.test(mount.alias)) throw new FSError('EINVAL', 'Invalid remote connection');
}

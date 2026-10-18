/** Shared application capabilities; implementations belong to backend/app-core. */
import type * as ToolContracts from '@itookit/tools/contracts';
import type * as VfsContracts from '@itookit/vfs-core';
import type { IFileSystem, FileSystemSourceOwner, OperationOptions } from '@itookit/vfs-core';
import type * as HarnessContracts from '@itookit/piagent-driver';
import type { HarnessObservation, HarnessStatusRow, HarnessProfile, HarnessConversationPort, HarnessConversationSnapshot } from '@itookit/piagent-driver';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import type { HarnessClient } from '@itookit/piagent-driver/harness';
import type { ISessionRepository, SessionFolder, SessionSummary, ConversationManifest } from '@itookit/llm-session/contracts';
import type * as FlowContracts from '@itookit/llm-flow/contracts';
import type { SessionSubmission } from '@itookit/llm-flow/contracts';
import type { MCPConnectionDiagnostic } from '../index';
import type { MCPDeletedProject, MCPDeletionReference } from './configuration';

export type ProjectConversationSnapshot = HarnessConversationSnapshot & {usageEstimate?: import('@itookit/kernel-adapters/contracts').UsageCostEstimate};
export interface ProjectConversationPort extends HarnessConversationPort {
    /** Stable host identity retained when a project draft becomes a native conversation. */
    readonly conversationId?: string;
    snapshot(): ProjectConversationSnapshot;
    read(): Promise<ProjectConversationSnapshot>;
    poll(): Promise<ProjectConversationSnapshot>;
    send(text: string, attachments?: HarnessContracts.HarnessAttachment[], selection?: HarnessContracts.HarnessModelSelection): Promise<ProjectConversationSnapshot>;
    command?(name: string, args?: string, selection?: HarnessContracts.HarnessModelSelection, inputText?: string): Promise<ProjectConversationSnapshot>;
    loadEarlier(): Promise<ProjectConversationSnapshot>;
    interrupt(): Promise<ProjectConversationSnapshot>;
    reconcile(): Promise<ProjectConversationSnapshot>;
    respond(id: string | number, response: Record<string, unknown>): Promise<ProjectConversationSnapshot>;
    fork(name?: string): Promise<ProjectConversationSnapshot>;
    rename?(name: string): Promise<ProjectConversationSnapshot>;
    archive?(archived: boolean): Promise<ProjectConversationSnapshot>;
    delete?(): Promise<ProjectConversationSnapshot>;
    subscribe(listener: () => void): () => void;
}

export interface RemoteHarnessAgent {
    id: string;
    name: string;
    description: string;
    source: string;
    icon: string;
    connectionId: string;
    profile: HarnessProfile;
}

export type ProjectTarget = {
    kind: 'project';
    projectId: string;
} | {
    kind: 'group';
    folder: string | null;
} | {
    kind: 'session';
    sessionId: string;
} | {
    kind: 'file';
    projectId: string;
    path: string;
};

export interface ProjectSessions {
    navigation(options?: {
        includeSessions?: boolean;
    }): Promise<ProjectNavigationSnapshot>;
    family(id: string): Promise<{
        root: string;
        members: SessionSummary[];
    }>;
    moveCandidates(id: string): Promise<SessionSummary[]>;
    rename(id: string, title: string): Promise<void>;
    reparent(id: string, parentSessionId: string | null): Promise<void>;
    create(title: string, folder: string | null): Promise<string>;
    createChild(parentSessionId: string): Promise<string>;
    get(id: string): Promise<ConversationManifest>;
}

export interface ProjectNavigationSnapshot {
    sessions: readonly SessionSummary[];
    folders: readonly SessionFolder[];
    roots: ReadonlyMap<string, string>;
    pending: readonly {
        id: string;
    }[];
}

/** A prepared navigation read model; paths are opaque loading targets for the UI. */
export interface ProjectNavigationView {
    path: string;
    projects: ProjectFolder[];
    project?: ProjectFolder;
    sessionId?: string;
    pendingDeletions: number;
    offlineProjectIds: string[];
    loadPaths: string[];
}

export interface ProjectNavigationRequest { path: string; projectId?: string | null }

export interface ProjectService {
    navigation(request: ProjectNavigationRequest): Promise<ProjectNavigationView>;
    execution?: ProjectExecutionService;
    readonly remoteMounts: ProjectRemoteMountPort | undefined;
    readonly sessions: ProjectSessions;
    readonly drafts: ProjectDraftService;
    readonly favorites: ProjectFavorites;
    readonly sessionMoves: ProjectSessionMoves;
    readonly canSelectDirectory: boolean;
    chooseDirectory(): Promise<string | null>;
    list(folders?: readonly SessionFolder[]): Promise<ProjectFolder[]>;
    navigationFromIndex: boolean;
    listNavigation(folders: readonly SessionFolder[]): ProjectFolder[];
    navigationFolders(folders?: readonly SessionFolder[]): Promise<SessionFolder[]>;
    initializeSources(): Promise<void>;
    subscribeChanges(listener: () => void): () => void;
    renameProject(from: string, to: string): Promise<void>;
    removeProjectSource(project: ProjectFolder): Promise<void>;
    storedProjectIds(): Promise<string[]>;
    inspectRemoteProjectRemoval(ids: readonly string[]): Promise<MCPDeletedProject[]>;
    removeRemoteProjectRecord(id: string, deleteFolder: (path: string) => Promise<void>): Promise<void>;
    get(id: string): Promise<ProjectFolder>;
    forFolder(path: string | null | undefined, folders?: readonly SessionFolder[]): Promise<ProjectFolder | undefined>;
    current(): Promise<ProjectFolder | undefined>;
    create(name: string, parent?: string | null, directory?: string): Promise<ProjectFolder>;
    createRemote(name: string, parent: string | null, connectionId: string, path: string, access?: 'ro' | 'rw', options?: OperationOptions & {
        createDirectory?: boolean;
    }): Promise<ProjectFolder>;
    discardImportedProject(project: ProjectFolder): Promise<void>;
    ensureDirectory(directory: string, label?: string): Promise<ProjectFolder>;
    personal(): Promise<ProjectFolder>;
    ensureStartup(directory?: string): Promise<void>;
    initializeSession(id: string): Promise<boolean>;
    adoptSession(id: string, reconcileFolder?: (folder: string) => Promise<void>): Promise<void>;
    sessionFolder(project: ProjectFolder): Promise<string>;
    openFiles(folder: string): Promise<VfsContracts.FileSystemSourceOwner>;
    fileSource(project: ProjectFolder): ProjectFileSource;
    workspaceAccess(project: ProjectFolder, requested?: 'ro' | 'rw'): 'ro' | 'rw';
    assertIndependent(project: ProjectFolder, mounts?: ProjectRemoteMount[], knownCatalog?: readonly ProjectFolder[]): Promise<void>;
    workspaceReadOnly(folder: string): Promise<boolean>;
    openWorkspace(folder: string): Promise<{
        fs: VfsContracts.FileSystemView;
        dispose(): Promise<void>;
    }>;
    assertMove(from: string | null, to: string | null, projectRoot?: boolean): Promise<void>;
}

export type ProjectFolder = SessionFolder & {
    displayName?: string;
} & {
    project: NonNullable<SessionFolder['project']>;
};

export interface ProjectRemoteMount extends RemoteFileConnection {
    capabilities?: import('@itookit/piagent-driver').RemoteProjectCapabilities;
    serverProjectId?: string;
    serverProjectRevision?: number;
    serverId?: string;
    mountId: string;
    at: string;
    root: string;
    access: 'ro' | 'rw';
    connectionId?: string;
}

export interface RemoteFileConnection {
    anonymous?: boolean;
    authorization?: import('@itookit/piagent-driver').RemoteAuthorization;
    endpoint: string;
    alias: string;
    credentialRef: string;
    username?: string;
}

export type ProjectFileSource = {
    kind: 'local';
    directory: string;
} | {
    kind: 'remote';
    reference: string;
};

export interface ProjectSessionMoves {
    move(id: string, folder: string): Promise<void>;
    ready(id: string): Promise<boolean>;
}

export interface ProjectFavorites {
    snapshot(): Readonly<Record<string, readonly ProjectFavorite[]>>;
    subscribe(listener: () => void): () => void;
    list(projectId: string): Promise<ProjectFavorite[]>;
    hasSession(sessionId: string): boolean;
    has(projectId: string, target: ProjectFavoriteTarget): boolean;
    toggle(projectId: string, target: ProjectFavoriteTarget, title: string): Promise<void>;
    remove(projectId: string, id: string): Promise<void>;
    include(projectId: string, favorites: readonly ProjectFavorite[]): Promise<void>;
    deleteFiles(projectId: string, paths: readonly string[]): Promise<void>;
    moveFiles(projectId: string, moves: readonly FavoriteMove[]): Promise<void>;
    deleteNativeSessions(projectId: string, target: Extract<ProjectFavoriteTarget, {
        kind: 'remote-session';
    }>, ids: readonly string[]): Promise<void>;
    updateNativeSession(projectId: string, target: Extract<ProjectFavoriteTarget, {
        kind: 'remote-session';
    }>, title: string, archived: boolean): Promise<void>;
}

export type ProjectFavoriteTarget = {
    kind: 'file';
    path: string;
    nodeType: 'file' | 'directory';
} | {
    kind: 'session';
    sessionId: string;
} | {
    kind: 'remote-session';
    connectionId: string;
    serverId: string;
    serverProjectId: string;
    profileId: string;
    sessionId: string;
    archived?: boolean;
};

export interface FavoriteMove {
    oldPath: string;
    newPath: string;
}

export interface ProjectFavorite {
    id: string;
    title: string;
    target: ProjectFavoriteTarget;
}

export interface ProjectDraftService {
    open(projectId: string, folder: string): Promise<ProjectDraftComposer>;
    ensure(projectId: string): Promise<void>;
    onPromoted(listener: (event: ProjectDraftPromotion) => void): () => void;
    submissionForSession(projectId: string, sessionId: string): Promise<SessionSubmission | undefined>;
    submitted(event: {
        sessionId: string;
        roundId: string;
        submission?: SessionSubmission;
    }): Promise<void>;
    recover(sessionId?: string, roundId?: string): Promise<void>;
    reconcile(projectId: string, sessionId?: string, roundId?: string): Promise<void>;
}

export interface ProjectDraftPromotion {
    type: 'project.draftPromoted';
    projectId: string;
    draftId: string;
    sessionId: string;
    submissionId: string;
    nextDraftId: string;
    state: 'promoted';
    remote?: {connectionId: string; serverProjectId: string; principalId?: string; profileId: string; nativeSessionId: string; turnId: string};
}

export interface ProjectDraftComposer {
    readonly id?: string;
    /** Reconcile durable submission evidence and replace this cursor only after its promotion. */
    refresh?(): Promise<ProjectDraftComposer | undefined>;
    readonly attachments: {
        put(content: ArrayBuffer): Promise<string>;
        read(id: string): Promise<ArrayBuffer>;
    };
    readonly initialData: string;
    save(data: string): Promise<void>;
    /** Return the replacement UUID so clients can update immutable RPC field snapshots. */
    clear(): Promise<string | void>;
    prepare(): Promise<{
        sessionId: string;
        resumeOnly: boolean;
        submission?: FlowContracts.SessionSubmission;
    }>;
}

export interface ProjectRemoteMountService {
    mountedProjectIds(): string[];
    readonly sessionStatus: RemoteSessionStatus;
    inspectRemoteProjects?: (ids: readonly string[]) => Promise<MCPDeletedProject[]>;
    removeRemoteProjects?: (ids: readonly string[]) => Promise<void>;
    existingProjectIds?: () => Promise<readonly string[]>;
    rootValidator?: (projectId: string, mount: ProjectRemoteMount) => Promise<void>;
    readonly diagnostics: Map<string, string[]>;
    readonly loadWarnings: string[];
    init(deferMCP?: boolean): Promise<void>;
    executionCapabilities(connectionId: string, options?: OperationOptions): Promise<ExecutionCapabilities>;
    list(projectId: string): ProjectRemoteMount[];
    connections(): RemoteFileSystemConfig[];
    connectionName(id: string): string | undefined;
    connectionDiagnostic(id: string): MCPConnectionDiagnostic;
    harness(connectionId: string): HarnessClient | Promise<HarnessClient>;
    connection(id: string): RemoteFileSystemConfig;
    resolveConnection(id: string, options?: OperationOptions): Promise<RemoteFileSystemConfig>;
    checkConnection(id: string, options?: OperationOptions): Promise<void>;
    checkDraft(input: RemoteFileSystemInput, password: string, id?: string, options?: OperationOptions): Promise<void>;
    browseDirectories(id: string, path: string, cursor?: string, options?: OperationOptions): Promise<{
        paths: string[];
        nextCursor: string | null;
    }>;
    saveConnection(input: RemoteFileSystemInput, password: string, id?: string): Promise<string>;
    removeConnection(id: string): Promise<void>;
    beforeMCPChange(server: MCPServer, previous?: MCPServer): Promise<void>;
    beforeMCPDelete(id: string): void;
    reconcileMCPReferences(): Promise<void>;
    mcpReferences(ids: readonly string[]): MCPDeletionReference[] | Promise<MCPDeletionReference[]>;
    removeMCPReferences(ids: readonly string[], expected: readonly MCPDeletionReference[], projectIds?: readonly string[]): Promise<void>;
    refreshMCPConnections(): Promise<void>;
    setMCPCredential(reference: string, password: string): void | (() => void);
    discoverMCP(endpoint: string, username: string | undefined, credentialRef: string, options?: OperationOptions): Promise<HarnessContracts.PiAgentDescriptor>;
    forgetProject(projectId: string): Promise<void>;
    findRemoteProject(connectionId: string, path: string): string | undefined | Promise<string | undefined>;
    bindProject(projectId: string, connectionId: string, path: string, access: 'ro' | 'rw', options?: OperationOptions & {
        createDirectory?: boolean;
        projectName?: string;
    }): Promise<void>;
    projectHarness(projectId: string, options?: OperationOptions): Promise<HarnessClient>;
    projectModels(projectId: string, profileId: string, options?: OperationOptions): Promise<HarnessContracts.HarnessModelCatalog>;
    remountProject(projectId: string, access: 'ro' | 'rw', options?: OperationOptions): Promise<void>;
    searchFiles(projectId: string, query: HarnessContracts.FileSearchQuery, options?: OperationOptions): Promise<HarnessContracts.FileSearchResult>;
    projectConversation(projectId: string, profileId: string, sessionId?: string, options?: OperationOptions, readOnly?: boolean, draftId?: string): Promise<ProjectConversationPort>;
    projectOffline(projectId: string): boolean;
    degraded(projectId: string): boolean;
    status(mountId: string): RemoteConnectionStatus;
    connectionStatus(id: string): RemoteConnectionStatus;
    assertUnmountable(projectId: string): Promise<void>;
    onChange(listener: () => void): () => void;
    checkConnections(projectId: string, options?: OperationOptions): Promise<void>;
    add(projectId: string, input: Omit<ProjectRemoteMount, 'mountId' | 'credentialRef' | 'access'> & {
        access?: 'ro' | 'rw';
    }, secret: string, base: IFileSystem, options?: OperationOptions): Promise<void>;
    remove(projectId: string, mountId: string): Promise<void>;
    reconnect(projectId: string, mountId: string, secret: string, options?: OperationOptions): Promise<void>;
    compose(projectId: string, input: FileSystemSourceOwner | (() => Promise<FileSystemSourceOwner>)): Promise<FileSystemSourceOwner>;
}

export type RemoteConnectionStatus = 'unknown' | 'checking' | 'online' | 'offline';

export type RemoteFileSystemInput = Pick<RemoteFileSystemConfig, 'name' | 'endpoint' | 'username' | 'anonymous'>;

export interface RemoteFileSystemConfig {
    anonymous?: boolean;
    authorization?: import('@itookit/piagent-driver').RemoteAuthorization;
    id: string;
    name: string;
    endpoint: string;
    username?: string;
    credentialRef: string;
    serverId?: string;
    projects?: boolean;
}

export interface ExecutionCapabilities {
    serverId: string | null;
    processEpoch?: string;
    pathModel?: 'none' | 'host-mapped' | 'virtual-root';
    process: {
        exec: boolean;
    };
    terminal: {
        pty: boolean;
    };
    executionModel: 'none' | 'trusted-cooperative-host' | 'sandbox';
    workspaceConsistency: 'none' | 'cooperative' | 'isolated';
    readOnlyEnforcement: 'none' | 'best-effort' | 'kernel-enforced';
}

export interface RemoteSessionStatus {
    get(projectId: string, profileId: string, sessionId: string): HarnessObservation | undefined;
    record(projectId: string, profileId: string, sessionId: string): HarnessStatusRow | undefined;
    fileVersion(projectId: string): string | undefined;
    subscribe(projectId: string, listener: () => void): () => void;
    refresh(projectId: string): Promise<void>;
}

export interface ProjectExecutionService {
    acquire(projectId: string, sessionId: string, scopeId?: string): Promise<{
        vfs: ToolContracts.ToolVFSContext;
        cwd: string;
        release(): Promise<void>;
        nativeShell?: ToolContracts.INativeShell;
        ttyDriver?: ToolContracts.ITTYDriver;
    } | undefined>;
}

export interface ProjectSearchQuery {
    query: string;
    scope: 'file-name' | 'file-path' | 'file-content' | 'session-title' | 'session-content' | 'session-prompt';
    /** Project-relative directory, including descendants; omitted means the whole project. */
    directory?: string;
    archived?: boolean;
    profileId?: string;
    /** Creation source filter for sessions only; files remain visible. */
    agentId?: string;
}

export interface ProjectSearchMatch {
    projectId: string;
    folder: string;
    kind: 'file' | 'session' | 'remote-session';
    summary: string;
    title: string;
    bindingIdentity?: string;
    path?: string;
    line?: number;
    profileId?: string;
    sessionId?: string;
    turnId?: string;
    itemId?: string;
    updatedAt?: number | null;
    archived?: boolean;
    resourcePath?: string;
    branch?: string;
}

export interface ProjectSearch {
    search(folder: string, query: ProjectSearchQuery, options?: OperationOptions): Promise<ProjectSearchResult>;
}

export interface ProjectSearchResult {
    matches: ProjectSearchMatch[];
    truncated: boolean;
    nextCursor: null;
    unavailableSources?: string[];
}

export type NativeSessionCommand = {
    kind: 'rename';
    name: string;
} | {
    kind: 'archive' | 'unarchive';
} | {
    kind: 'delete';
    preserveSessionId?: string;
};

export declare function listRemoteHarnessAgents(remote?: ProjectRemoteMountPort): Promise<RemoteHarnessAgent[]>;

export declare function remoteSessionSources(projects: ProjectService, owner: ProjectFolder, registered: readonly ProjectFolder[]): ProjectFolder[];

export declare function manageRemoteSession(projects: ProjectService, folder: string, profile: string, session: string, command: NativeSessionCommand, options?: OperationOptions): Promise<HarnessConversationSnapshot>;

export declare function resolveProjectFavorite(projects: Pick<ProjectService, 'forFolder' | 'favorites' | 'remoteMounts'>, repository: Pick<ISessionRepository, 'getManifest'>, folder: string, id: string): Promise<ResolvedProjectFavorite>;

export interface ResolvedProjectFavorite {
    path: string;
    kind: 'file' | 'directory' | 'session';
}

export declare function exportRemoteSession(projects: ProjectService, folder: string, profileId: string, sessionId: string, options?: OperationOptions): Promise<{
    name: string;
    content: string;
    mimeType: string;
}>;

/** UI capabilities exclude credential injection, host change hooks and source composition. */
export type ProjectRemoteMountPort = Omit<ProjectRemoteMountService, 'mountedProjectIds' | 'beforeMCPChange' | 'beforeMCPDelete' | 'setMCPCredential' | 'compose'>;

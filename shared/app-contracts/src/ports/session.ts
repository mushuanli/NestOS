/** Shared application capabilities; implementations belong to backend/app-core. */
import type * as VfsContracts from '@itookit/vfs-core';
import type { IFileSystem, OperationOptions, FSNode } from '@itookit/vfs-core';
import type { ISessionRepository, ConversationManifest, ChatSessionSettings, PlanCommandRequest, ExecCommandRequest } from '@itookit/llm-session/contracts';
import type * as KernelContracts from '@itookit/durable-kernel/contracts';
import type { TaskRecord, EventEnvelope } from '@itookit/durable-kernel/contracts';
import type { ProjectTarget, ProjectService, ProjectSearch } from './projects';
import type { SessionFilesService } from './files';
import type { ApplicationKernelPort } from './local';
import type {SessionPresentationState} from '@itookit/llm-session/contracts';

export interface SessionLifecycleService {
    closeSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    deleteFolder(path: string, recursive?: boolean): Promise<void>;
}

export declare function taskKeyEvent(event: EventEnvelope): {
    sequence: number;
    occurredAt: number;
    type: string;
    payload: unknown;
} | undefined;

export declare function taskSummary(task: TaskRecord): {
    id: string;
    sessionId: string;
    parentTaskId: string | undefined;
    program: KernelContracts.ProgramRef;
    status: KernelContracts.TaskStatus;
    version: number;
    createdAt: number;
    updatedAt: number;
    input: unknown;
    output: unknown;
    error: KernelContracts.SerializableError | undefined;
    control: {
        readonly requested: "cancel" | "run" | "pause" | "interrupt";
        readonly acknowledged: boolean;
    };
    activeOperations: number;
};

export declare function exportSessionBundle(repository: ISessionRepository, sessionId: string): Promise<SessionExport>;

export interface SessionExport {
    name: string;
    content: string;
    mimeType: string;
}

export interface WorkbenchArchiveImporter {
    import(content: string, target: ProjectTarget): Promise<ProjectTarget[]>;
}

export interface WorkbenchArchiveExporter {
    export(targets: readonly ProjectTarget[]): Promise<WorkbenchArchive>;
}

export interface WorkbenchArchive {
    format: 'itookit.workbench';
    version: 1;
    items: WorkbenchArchiveItem[];
}

export type WorkbenchArchiveItem = {
    kind: 'project';
    name: string;
    files: FileArchiveEntry[];
    children: WorkbenchArchiveItem[];
} | {
    kind: 'group';
    name: string;
    children: WorkbenchArchiveItem[];
} | {
    kind: 'session';
    data: SessionBundle;
    attachments?: FileArchiveEntry[];
    children: WorkbenchArchiveItem[];
} | {
    kind: 'files';
    entries: FileArchiveEntry[];
};

export interface FileArchiveEntry {
    path: string;
    type: 'file' | 'directory' | 'seqfile';
    base64?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    icon?: string;
    mimeType?: string;
    assets?: FileArchiveEntry[];
    records?: Array<{
        key: string;
        value: string;
    }>;
}

export interface SessionBundle {
    format: typeof SESSION_BUNDLE_FORMAT;
    version: typeof SESSION_BUNDLE_VERSION;
    manifest: SessionBundleManifest;
    settings: ChatSessionSettings;
    documents: Record<string, string>;
    attachments: SessionAttachmentBundle[];
}

export interface SessionAttachmentBundle {
    name: string;
    base64: string;
}

export interface SessionBundleManifest {
    title: string;
    summary?: string;
    origin?: ConversationManifest['origin'];
    folder?: string | null;
    uiState?: ConversationManifest['uiState'];
    flow?: ConversationManifest['flow'];
    rootRoundId: ConversationManifest['rootRoundId'];
    branches: ConversationManifest['branches'];
    branchMeta: ConversationManifest['branchMeta'];
    currentBranch: string;
    currentHead: ConversationManifest['currentHead'];
    children: ConversationManifest['children'];
}

export declare const SESSION_BUNDLE_VERSION = 2;

export declare const SESSION_BUNDLE_FORMAT = "itookit.session";

export interface SessionLifecycleOptions {
    /**
     * Bound for the whole close step: both the `closeSession` call (which waits for in-flight
     * Effects to confirm their stop) and the wait for the ApplicationKernelPort to reach `closed`; default 30s.
     */
    closeTimeoutMs?: number;
    closePollMs?: number;
}

export interface SessionLifecycleDependencies {
    repository: ISessionRepository;
    kernel: ApplicationKernelPort;
}

export interface SessionBrowserPort extends VfsContracts.FileSystemSourceOwner {
    transferItems: (mode: "copy" | "move", ids: string[], destination: string) => Promise<void>;
    readFileDirectory: (path: string, options?: FileDirectoryOptions) => Promise<{
        node: FSNode;
        nodes: FSNode[];
    }>;
    invalidateNavigation: () => Promise<void>;
}

export declare function createSessionBrowser(deps: SessionBrowserDependencies): Promise<SessionBrowserPort>;

export interface FileDirectoryOptions extends OperationOptions {
    fs?: IFileSystem;
    node?: FSNode;
}

export interface SessionBrowserDependencies {
    displayedFilesPolicy?: 'gitignore' | 'all';
    repository: ISessionRepository;
    projects?: ProjectService;
    files: SessionFilesService;
    kernel: ApplicationKernelPort;
    /** Defaults to a service over `repository` and `kernel`. */
    lifecycle?: SessionLifecycleService;
    /** Optional host presentation policy. Raw project/Session file APIs are unaffected. */
    filterDisplayedFiles?(fs: IFileSystem, nodes: FSNode[], signal?: AbortSignal): Promise<FSNode[]>;
}
/** One workspace query supplies the services and the first directory projection. */
export interface WorkbenchView {
    initialData?: SessionEditorInitialData;
    initialSession?: SessionOpenView;
    browser: SessionBrowserPort;
    lifecycle: SessionLifecycleService;
    search?: ProjectSearch;
    navigation?: import('./projects').ProjectNavigationView;
    directory?: { revision: number; node: FSNode | null; nodes: FSNode[] };
    chat?: WorkbenchChatControls;
    connections?: ConnectionObservation;
}

export interface WorkbenchChatControls {
    privilegedCommands: PrivilegedCommandService;
    sessionSkills: import('@itookit/tools/contracts').SessionSkillControls;
    configuration?: import('@itookit/kernel-adapters/contracts').ChatConfigurationView;
}

/** An interest lease owns probes, never Session execution. */
export interface ConnectionObservation {
    update(projectIds: string[], revision: number): Promise<void>;
    dispose(): Promise<void>;
}

/** Prepared once by the backend; the editor owns the returned file lease. */
export interface SessionEditorInitialData extends SessionPresentationState {
    sessionId: string;
    snapshot: import('@itookit/llm-session/contracts').SessionSnapshot;
    title: string;
    manifest: ConversationManifest;
    settings: ChatSessionSettings;
}

export interface SessionOpenView {
    activate(branch?: string): Promise<SessionEditorInitialData>;
    manifest: ConversationManifest;
    project: import('./projects').ProjectFolder | null | undefined;
    workspaceReadOnly: boolean;
    context: VfsContracts.FileSystemContext;
    dispose(): Promise<void>;
}

export type SessionOrganizationStore = Pick<ISessionRepository, 'list' | 'listSummaries' | 'listFolders' | 'pendingSessionDeletions' | 'getManifest' | 'updateManifest' | 'createSession'>;

export interface PrivilegedCommandService {
    plan(request: PlanCommandRequest): Promise<string>;
    exec(request: ExecCommandRequest): Promise<string>;
}

export interface MindosInitialFiles {
    list(): Promise<InitialFileEntry[]>;
    restore(ids: string[]): Promise<InitialFileResult[]>;
}

export interface InitialFileResult {
    id: string;
    status: 'restored' | 'preserved' | 'failed';
    error?: string;
}

export interface InitialFileEntry {
    id: string;
    group: 'notes' | 'flows';
    name: string;
    path: string;
    exists: boolean;
}

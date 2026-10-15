/** Shared application capabilities; implementations belong to backend/app-core. */
import type * as ToolContracts from '@itookit/tools/contracts';
import type { IFileSystem, FileSystemMount, FileSystemSourceOwner, FileSystemContextOwner } from '@itookit/vfs-core';

export interface SessionMountRecord {
    mountId: string;
    at: string;
    sourceId: string;
    root?: string;
    access: 'ro' | 'rw';
}

export interface SessionFilesService {
    beforeAcquire?: (sessionId: string) => Promise<void>;
    workspaceComposer?: (id: string, mount: FileSystemMount) => Promise<FileSystemSourceOwner | undefined>;
    workspaceProvider?: (id: string, mount: SessionMountRecord) => Promise<FileSystemSourceOwner | undefined>;
    invalidate(id: string): Promise<void>;
    subscribe(listener: () => void): () => void;
    initialize(): Promise<void>;
    source(id: string): IFileSystem | undefined;
    registerSource(id: string, source: IFileSystem): void;
    inspect(sessionId: string): Promise<FilesRecord | null>;
    configure(sessionId: string, config: {
        mounts: SessionMountRecord[];
        cwd: string;
    }, expectedRevision: number): Promise<FilesRecord>;
    disable(sessionId: string, expectedRevision: number): Promise<FilesRecord>;
    acquire(sessionId: string): Promise<{
        vfs: ToolContracts.ToolVFSContext;
        cwd: string;
        release: () => Promise<void>;
    }>;
    acquireWorkspaceFiles(sessionId: string, mountId: string, fs: IFileSystem, access?: 'ro' | 'rw'): Promise<FileSystemContextOwner>;
    acquireFiles(sessionId: string, cwd?: string): Promise<FileSystemContextOwner>;
    dispose(): Promise<void>;
}

export interface FilesRecord {
    revision: number;
    state: 'active' | 'draining' | 'disabled';
    mounts: SessionMountRecord[];
    cwd: string;
}

export interface DirectorySourceProvider {
    selectDirectory(): Promise<string | null>;
    /** Returns a source rooted at exactly the selected directory. Owned by the provider. */
    openDirectory(path: string): Promise<IFileSystem>;
    dispose(): Promise<void>;
}

export interface DirectoryMountService {
    readonly fixedWorkspace: (sessionId: string) => Promise<string | undefined>;
    workspaceGuard?: (sessionId: string) => Promise<void>;
    init(): Promise<void>;
    resolveSource(sourceId: string): Promise<IFileSystem | undefined>;
    dispose(): Promise<void>;
    listDirectories(path?: string): Promise<string[]>;
    describe(mount: SessionMountRecord): string | Promise<string>;
    readonly canSelectHost: boolean;
    processMounts(sessionId: string): Promise<SessionProcessMount[]>;
    getHome(): string | undefined;
    chooseDirectory(): Promise<string | null>;
    openDirectory(directory: string): Promise<FileSystemSourceOwner>;
    inspectDirectory(directory: string): Promise<FileSystemSourceOwner>;
    setHome(directory: string): Promise<string>;
    mountHome(sessionId: string): Promise<string>;
    addDirectory(sessionId: string, directory: string, access?: 'ro' | 'rw', at?: string, asCwd?: boolean): Promise<string>;
    setWorkspace(sessionId: string, directory: string, access?: 'ro' | 'rw'): Promise<string>;
    restoreWorkspace(sessionId: string, directory: string, access: 'ro' | 'rw'): Promise<string>;
    assertWorkspaceChange(sessionId: string): Promise<void>;
    remove(sessionId: string, mountId: string): Promise<void>;
    reconnect(sessionId: string, mountId: string): Promise<void>;
    update(sessionId: string, mountId: string, access: 'ro' | 'rw', asCwd: boolean): Promise<void>;
}

export interface SessionProcessMount {
    sourceId: string;
    directory: string;
    at: string;
    access: 'ro' | 'rw';
}

/** Browser-facing file capabilities exclude manager, driver and execution ownership. */
export type DeviceDescription = Pick<import('@itookit/vfs-core').IDeviceDriver, 'handlerId' | 'description' | 'writable' | 'streamable' | 'sessionable'>;
export interface FileSystemsPort {
    openFileSystem(rootPath: string): Promise<IFileSystem>;
    readonly ioStats: import('@itookit/vfs-core').IVFSManager['ioStats'];
    readonly devices: { list(): string[]; get(id: string): DeviceDescription };
}
export type SessionFilesPort = Pick<SessionFilesService, 'invalidate' | 'subscribe' | 'inspect' | 'configure' | 'disable' | 'acquireFiles'>;
export type DirectoryMountPort = Pick<DirectoryMountService, 'fixedWorkspace' | 'resolveSource' | 'listDirectories' | 'describe' | 'canSelectHost' | 'getHome' | 'chooseDirectory'
    | 'openDirectory' | 'inspectDirectory' | 'setHome' | 'mountHome' | 'addDirectory' | 'setWorkspace' | 'restoreWorkspace' | 'assertWorkspaceChange' | 'remove' | 'reconnect' | 'update'>;

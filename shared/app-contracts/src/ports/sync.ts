/** Shared application capabilities; implementations belong to backend/app-core. */
import type * as SyncContracts from '@itookit/vfs-sync';
import type { bindingToken, StoredFilePlan, FilePlan, Binding } from '@itookit/vfs-sync';

export interface ProjectSyncService {
    readonly bindingToken: (binding: Parameters<typeof bindingToken>[0]) => string | Promise<string>;
    preview(projectId: string): Promise<StoredFilePlan>;
    execute(projectId: string, planId: string): Promise<FilePlan>;
    compare(projectId: string, planId: string, path: string): Promise<ProjectSyncComparison>;
    resolve(projectId: string, planId: string, decisions: Record<string, 'local' | 'remote'>): Promise<StoredFilePlan>;
    mergeText(projectId: string, planId: string, paths: string[]): Promise<StoredFilePlan>;
    reconcileExpired(projectId: string): Promise<StoredFilePlan>;
    recover(projectId: string): Promise<void>;
    status(projectId: string): Promise<SyncContracts.SyncState>;
    unbind(projectId: string): Promise<void>;
    configure(projectId: string, expectedToken: string, change: Pick<Binding, 'direction'>): Promise<void>;
}

export interface ProjectSyncComparison {
    path: string;
    baseline: ProjectSyncContent;
    local: ProjectSyncContent;
    remote: ProjectSyncContent;
}

export interface ProjectSyncContent {
    kind: 'missing' | 'file' | 'directory';
    hash?: string | null;
    size?: number;
    content?: {
        text?: string;
        reason?: 'binary' | 'too-large' | 'unavailable';
    };
}

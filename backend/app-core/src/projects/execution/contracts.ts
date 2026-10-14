import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import type { RemoteFileConnection, ProjectRemoteMount } from '../remote-mounts';

/** Structural support is separate from project grants and connection health. */
export interface ExecutionCapabilities {
    serverId: string | null;
    processEpoch?: string;
    pathModel?: 'none' | 'host-mapped' | 'virtual-root';
    process: { exec: boolean };
    terminal: { pty: boolean };
    executionModel: 'none' | 'trusted-cooperative-host' | 'sandbox';
    workspaceConsistency: 'none' | 'cooperative' | 'isolated';
    readOnlyEnforcement: 'none' | 'best-effort' | 'kernel-enforced';
}
interface ExecutionBindingIdentity {
    connectionId: string;
    serverId: string;
    requiredIsolation: 'trusted-cooperative-host' | 'sandbox';
    authorizationRevision: string;
}
export type ProjectExecutionBinding = ExecutionBindingIdentity & (
    { version: 2; mode: 'directory' }
);
export type ProjectExecutionContext = Awaited<ReturnType<NonNullable<KernelAdaptersRuntimeOptions['fileContextForSession']>>>;
export interface ProjectExecutionProvider {
    /** Return file and process access to the same authorized directory namespace. */
    acquire(input: {
        projectId: string; sessionId: string; scopeId?: string;
        binding: ProjectExecutionBinding;
        connection: Omit<RemoteFileConnection, 'alias'>;
        mounts: readonly ProjectRemoteMount[];
    }): Promise<ProjectExecutionContext>;
}

/** The use case reads only connection identity and currently granted directories. */
export interface ProjectExecutionSources {
    list(projectId: string): ProjectRemoteMount[];
    connection(connectionId: string): Omit<RemoteFileConnection, 'alias'>;
    executionCapabilities(connectionId: string): Promise<ExecutionCapabilities>;
}

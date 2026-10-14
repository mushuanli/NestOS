import { FSError } from '@itookit/vfs-core';
import type { ProjectExecutionProvider, ProjectExecutionSources } from './contracts';
import { resolveExecutionBinding, executionGrantRevision, executionGrantChanged } from './policy';

/** Execution follows the remote root's advertised capability, never a UI toggle. */
export class ProjectExecutionService {
    constructor(private readonly remote: ProjectExecutionSources, private readonly provider?: ProjectExecutionProvider) {}

    async acquire(projectId: string, sessionId: string, scopeId?: string) {
        const mounts = this.remote.list(projectId);
        const root = mounts.find(mount => mount.at === '/');
        if (!root?.connectionId) return undefined;
        const caps = await this.remote.executionCapabilities(root.connectionId);
        const binding = resolveExecutionBinding(mounts, root.connectionId, caps);
        if (!binding) return undefined;
        if (!this.provider) throw new FSError('ECAPABILITY', 'Remote execution provider is unavailable');
        const connection = this.remote.connection(binding.connectionId);
        const context = await this.provider.acquire({ projectId, sessionId, scopeId, binding, mounts, connection });
        try {
            if (executionGrantRevision(this.remote.list(projectId), binding.connectionId) !== binding.authorizationRevision)
                throw executionGrantChanged();
            if (!context.nativeShell) throw new FSError('ECAPABILITY', 'Remote directory has no process driver');
            return context;
        } catch (error) {
            try { await context.release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Remote directory verification and cleanup failed'); }
            throw error;
        }
    }
}

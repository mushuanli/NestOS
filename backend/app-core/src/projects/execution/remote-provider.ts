import { FSError } from '@itookit/vfs-core';
import type { SessionFilesService } from '@itookit/app-contracts/services';
import { workspacePath } from '../../vfs/workspace-namespace';
import type { ProjectRemoteMount, RemoteFileSourceProvider, RemoteProcessMount } from '../remote-mounts';
import { requireRemoteProcessGrant } from './policy';
import type { ProjectExecutionProvider } from './contracts';

/**
 * Adapt the shared HTTP file/process ports into an execution provider without importing
 * a transport into app-core. Authorization policy lives in `requireRemoteProcessGrant`;
 * this module only orders inspect → acquire → process → release.
 */
export function createRemoteExecutionProvider(files: Pick<SessionFilesService, 'inspect' | 'acquire'>, provider: Pick<RemoteFileSourceProvider, 'process' | 'projectProcess' | 'projects' | 'capabilities'>): ProjectExecutionProvider | undefined {
    if (!provider.process || !provider.capabilities) return;
    const acquireProcess = provider.process.bind(provider), capabilities = provider.capabilities.bind(provider);
    return { async acquire({ sessionId, connection, mounts, binding }) {
        const record = await files.inspect(sessionId);
        if (!record || record.state !== 'active') throw new FSError('ECAPABILITY', 'Remote execution requires an active Session grant');
        const caps = await capabilities(connection);
        const epoch = requireRemoteProcessGrant(binding, caps, record.mounts);
        const context = await files.acquire(sessionId);
        try {
            if (JSON.stringify(await files.inspect(sessionId)) !== JSON.stringify(record))
                throw new FSError('ECONFLICT', 'Session directory authorization changed');
            const root=mounts.find(mount => mount.at==='/');
            let remoteProject: import('@itookit/piagent-driver').RemoteProject | undefined;
            if (root?.serverProjectId && (!provider.projects || !provider.projectProcess)) throw new FSError('ECAPABILITY','Project-scoped remote execution unavailable');
            if (root?.serverProjectId && provider.projects) {
                const client=provider.projects(connection);
                try {remoteProject=await client.read(root.serverProjectId);}finally{await client.close();}
            }
            const spec={ serverId: binding.serverId, epoch, cwd: context.cwd,
                mounts: processMounts(mounts, record.mounts[0].access) };
            const process=remoteProject && provider.projectProcess ? await provider.projectProcess(connection,remoteProject,spec) : await acquireProcess(connection,spec);
            return { ...context, nativeShell: process.nativeShell, release: async () => { await process.release(); await context.release(); } };
        } catch (error) { await context.release(); throw error; }
    } };
}

/** The Session grant decides read-only attenuation; project grants keep their own access. */
function processMounts(mounts: readonly ProjectRemoteMount[], sessionAccess: 'ro' | 'rw'): RemoteProcessMount[] {
    return mounts.map(mount => ({ alias: mount.alias, path: mount.root.replace(/^\//, ''), at: workspacePath(mount.at),
        access: sessionAccess === 'ro' ? 'ro' : mount.access }));
}

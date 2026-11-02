import type {RemoteFileSourceProvider, ProjectRemoteMountService, RemoteProcessHandle} from '../projects/remote-mounts';
import {requireValue} from '../kanban/validation';

/** Acquire the existing authorized project process; lifecycle stages share this boundary. */
export async function developmentWorkspace<T>(remote: ProjectRemoteMountService, provider: RemoteFileSourceProvider,
    projectId: string, work: (process: RemoteProcessHandle, nodeConnectionId: string) => Promise<T>): Promise<T> {
    const root = remote.list(projectId).find(mount => mount.at === '/');
    requireValue(root?.connectionId && root.serverProjectId && root.access === 'rw', 'REMOTE_WORKSPACE_REQUIRED');
    requireValue(provider.projects && provider.projectProcess && provider.capabilities, 'WORKSPACE_PROCESS_UNAVAILABLE');
    const connection = await remote.resolveConnection(root.connectionId), client = provider.projects(connection);
    try {
        const project = await client.read(root.serverProjectId), caps = await provider.capabilities(connection);
        requireValue(project.revision === root.serverProjectRevision && caps.serverId === root.serverId && caps.processEpoch, 'WORKSPACE_BINDING_CHANGED');
        const process = await provider.projectProcess(connection, project, {serverId: caps.serverId, epoch: caps.processEpoch, cwd: '/workspace',
            mounts: [{alias: project.alias, path: project.path, at: '/workspace', access: project.access}, ...project.mounts]});
        try {return await work(process, root.connectionId);}
        finally {await process.release();}
    } finally {await client.close();}
}

import type {OperationOptions} from '@itookit/vfs-core';
import type {RemoteAuthorizationInspection} from '@itookit/app-contracts/services';
import type {ProjectRemoteMount, RemoteFileConnection, RemoteFileSourceProvider} from './remote-mounts';
import {diagnosticFailure} from '../diagnostics/failure';

/** Only read capabilities offered to the current principal; never infer a grant from MCP connectivity. */
export async function inspectAuthorization(provider: RemoteFileSourceProvider, connection: Omit<RemoteFileConnection, 'alias'>,
    mount: ProjectRemoteMount, options?: OperationOptions): Promise<RemoteAuthorizationInspection> {
    const result: RemoteAuthorizationInspection = {checkedAt: Date.now(), authentication: 'unknown', exportAccess: 'unknown', projectAccess: 'unknown', reason: 'unverified'};
    if (!provider.projects) return result;
    const client = provider.projects(connection);
    try {
        if (typeof client.roots !== 'function') return result;
        const roots = await client.roots(options), root = roots.roots.find(root => root.alias === mount.alias);
        result.authentication = 'accepted'; result.exportAccess = root?.access ?? 'none';
        if (!root) return {...result, projectAccess: 'denied', reason: 'export-not-granted', code: 'REMOTE_EXPORT_NOT_GRANTED'};
        if (!mount.serverProjectId) return result;
        const project = await client.read(mount.serverProjectId, options);
        return {...result, projectAccess: project.access, projectRevision: project.revision, principalId: project.authorization?.principalId,
            authorizationRevision: project.authorization?.revision, capabilities: project.capabilities,
            reason: project.revision !== mount.serverProjectRevision || project.authorization?.revision !== mount.authorization?.revision ? 'binding-outdated' : 'available'};
    } catch (error) {
        const detail = diagnosticFailure(error), denied = [detail.code, ...detail.causeCodes].some(code => code === 'EACCES' || code === 'EACCESS');
        return {...result, ...(denied ? {projectAccess: 'denied', reason: 'project-denied'} as const : {}), code: detail.code, causeCodes: detail.causeCodes};
    } finally {await client.close();}
}

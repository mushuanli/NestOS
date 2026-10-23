import { FSError } from '@itookit/vfs-core';
import { validateAuthorization } from '@itookit/mindos-node-driver/authorization';
import type { JsonValue } from '@itookit/durable-kernel';
import type { HarnessExecutionConnection } from '@itookit/kernel-adapters/contracts';
import type { ProjectRemoteMount } from './remote-mounts';
import type { RemoteFileSystemConfig } from './remote-connections';
import { safeId } from './harness-connection-store';

const fields = new Set(['id', 'name', 'kind', 'nodeConnectionId', 'projectId', 'profileId', 'enabled', 'selection']);
export function normalizeHarnessConnection(value: HarnessExecutionConnection): HarnessExecutionConnection {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !fields.has(key)) || value.kind !== 'harness'
        || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256
        || typeof value.profileId !== 'string' || !value.profileId.trim() || value.profileId.length > 128 || /\0/.test(value.profileId)
        || value.enabled !== undefined && typeof value.enabled !== 'boolean') throw invalid();
    safeId(value.id); safeId(value.nodeConnectionId); safeId(value.projectId);
    const selection = value.selection;
    if (selection && (typeof selection !== 'object' || Object.keys(selection).some(key => !['modelId', 'reasoningEffort'].includes(key))
        || typeof selection.modelId !== 'string' || !selection.modelId.trim() || selection.modelId.length > 256
        || selection.reasoningEffort !== undefined && (typeof selection.reasoningEffort !== 'string' || !selection.reasoningEffort.trim() || selection.reasoningEffort.length > 128))
        || selection !== undefined && !selection) throw invalid();
    return { id: value.id, name: value.name.trim(), kind: 'harness', nodeConnectionId: value.nodeConnectionId,
        projectId: value.projectId, profileId: value.profileId, ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
        ...(selection ? { selection: structuredClone(selection) } : {}) };
}

/** The snapshot carries grant identity only; credential references and secrets stay in the host. */
export function harnessProjectIdentity(connection: HarnessExecutionConnection, mounts: ProjectRemoteMount[], node: RemoteFileSystemConfig): JsonValue {
    const root = mounts.find(mount => mount.at === '/');
    if (!root || root.connectionId !== connection.nodeConnectionId || mounts.some(mount => mount.connectionId !== connection.nodeConnectionId)
        || !root.serverProjectId || !Number.isSafeInteger(root.serverProjectRevision) || root.serverProjectRevision! < 1
        || !node.serverId || root.serverId !== node.serverId) throw new FSError('ECAPABILITY', 'Execution connection requires a complete remote project binding');
    const authorization = validateAuthorization(node.authorization), granted = validateAuthorization(root.authorization);
    if (!authorization || !granted || canonical(authorization) !== canonical(granted))
        throw new FSError('EACCES', 'Remote project authorization is unavailable or changed');
    if (root.capabilities && (!root.capabilities.run || !root.capabilities.sessionControl))
        throw new FSError('EACCES', 'Remote project does not authorize Agent execution');
    const grants = [...mounts].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).map(mount => ({
        mountId: mount.mountId, connectionId: mount.connectionId!, alias: mount.alias, root: mount.root, at: mount.at, access: mount.access,
    }));
    return { projectId: connection.projectId, serverId: node.serverId, serverProjectId: root.serverProjectId,
        serverProjectRevision: root.serverProjectRevision!, authorization: { ...authorization }, grants };
}
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
    return JSON.stringify(value);
}
function invalid() { return new FSError('EINVAL', 'Invalid harness execution connection'); }

import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectFavoriteTarget } from '../projects/favorites/contracts';
import type { ProjectService } from '@itookit/app-contracts/services';
import type { HarnessConversationSnapshot } from '@itookit/nestos-node-driver';

export type NativeSessionCommand = {kind: 'rename'; name: string} | {kind: 'archive' | 'unarchive'} | {kind: 'delete'; preserveSessionId?: string};
/** Management uses the same persistent mutation journal as the opened conversation. */
export async function manageRemoteSession(projects: ProjectService, folder: string, profile: string, session: string, command: NativeSessionCommand, options?: OperationOptions): Promise<HarnessConversationSnapshot> {
    const project = await projects.forFolder(folder);
    if (!project || project.path !== folder || !projects.remoteMounts) throw new FSError('ENOENT', 'Native project unavailable');
    const mount = projects.remoteMounts.list(project.project.id).find(item => item.at === '/');
    const grant = JSON.stringify(mount);
    const identity = mount && {kind: 'remote-session' as const, connectionId: mount.connectionId, serverId: mount.serverId, serverProjectId: mount.serverProjectId, profileId: profile, sessionId: session};
    const controls = await projects.remoteMounts.projectConversation(project.project.id, profile, session, options);
    try {
        const snapshot = await controls.read();
        if (snapshot.pending) throw new FSError('EBUSY', 'Reconcile the previous native operation first');
        if (command.kind === 'delete' && command.preserveSessionId && !snapshot.deletedSessionIds?.length) await assertBranchRemovable(controls, session, command.preserveSessionId);
        const result = command.kind === 'delete' && snapshot.deletedSessionIds?.length ? snapshot : await applyCommand(controls, command);
        if (identity?.connectionId && identity.serverId && identity.serverProjectId) {
            const current = projects.remoteMounts.list(project.project.id).find(item => item.at === '/');
            if (JSON.stringify(current) !== grant) throw new FSError('ECONFLICT', 'Native operation committed, but the project binding changed');
            await updateFavorites(projects, project.project.id, command, result,
                {...identity, connectionId: identity.connectionId, serverId: identity.serverId, serverProjectId: identity.serverProjectId});
        }
        return result;
    } finally { await controls.close(); }
}

async function applyCommand(controls: import('@itookit/nestos-node-driver').HarnessConversationPort, command: NativeSessionCommand): Promise<HarnessConversationSnapshot> {
    if (command.kind === 'rename') {
        if (!controls.rename) throw new FSError('ECAPABILITY', 'Native rename unavailable');
        return controls.rename(command.name);
    }
    if (command.kind === 'delete') {
        if (!controls.delete) throw new FSError('ECAPABILITY', 'Native deletion unavailable');
        return controls.delete();
    }
    if (!controls.archive) throw new FSError('ECAPABILITY', 'Native archive unavailable');
    return controls.archive(command.kind === 'archive');
}

async function updateFavorites(projects: ProjectService, projectId: string, command: NativeSessionCommand,
    result: HarnessConversationSnapshot, identity: Extract<ProjectFavoriteTarget, {kind: 'remote-session'}>): Promise<void> {
    try {
        if (command.kind === 'delete') await projects.favorites?.deleteNativeSessions(projectId, identity, result.deletedSessionIds);
        else await projects.favorites?.updateNativeSession(projectId, identity, result.title, result.archived);
    } catch { throw new FSError('EIO', 'Native operation committed, but updating the local favorite failed'); }
}

/** Native removal can cascade; protect the currently viewed branch before committing. */
async function assertBranchRemovable(controls: import('@itookit/nestos-node-driver').HarnessConversationPort, target: string, preserve: string): Promise<void> {
    const branches = await controls.branches();
    const byId = new Map(branches.map(branch => [branch.id, branch]));
    let id: string | null | undefined = preserve;
    const visited = new Set<string>();
    while (id) {
        if (id === target) throw new FSError('EBUSY', 'Cannot delete the current native branch or its ancestors');
        if (visited.has(id)) throw new FSError('EIO', 'Cyclic native branch family');
        visited.add(id);
        const branch = byId.get(id);
        if (!branch) throw new FSError('ECONFLICT', 'Cannot verify the current native branch ancestry');
        id = branch.parentSessionId;
    }
}

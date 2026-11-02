import {traceHarnessConnection} from './harness-connection-diagnostics';
import {sha256Hex} from '@itookit/common';
import {FSError} from '@itookit/vfs-core';
import type {HarnessExecutionConnection} from '@itookit/kernel-adapters/contracts';
import type {HarnessConnectionService} from './harness-connections';
import type {ProjectRemoteMountService} from './remote-mounts';

export interface DraftHarnessTarget {profileId: string; expectedProject?: {nodeConnectionId: string; serverProjectId: string}; selection?: HarnessExecutionConnection['selection']}
/** Reuse a durable target without copying node credentials or altering existing connections. */
export function prepareHarnessDraftConnection(service: HarnessConnectionService, remote: Pick<ProjectRemoteMountService, 'list' | 'projectHarness'>,
    projectId: string, target: DraftHarnessTarget): Promise<string> {
    return traceHarnessConnection('harness.draft.prepare', projectId, () => prepareConnection(service, remote, projectId, target));
}
async function prepareConnection(service: HarnessConnectionService, remote: Pick<ProjectRemoteMountService, 'list' | 'projectHarness'>,
    projectId: string, target: DraftHarnessTarget): Promise<string> {
    const root = remote.list(projectId).find(mount => mount.at === '/' && mount.access === 'rw');
    if (!root?.connectionId || !root.serverProjectId || !target || typeof target.profileId !== 'string' || !target.profileId.trim())
        throw new FSError('EACCES', 'A writable registered remote project and harness profile are required');
    if (target.expectedProject && (target.expectedProject.nodeConnectionId !== root.connectionId || target.expectedProject.serverProjectId !== root.serverProjectId))
        throw new FSError('ECONFLICT', 'The selected remote project changed before preparation');
    const client = await remote.projectHarness(projectId, {requireRegistered: true});
    try {
        const profile = (await client.profiles()).profiles.find(item => item.id === target.profileId && item.projectRuntime);
        if (!profile?.workspaces.some(workspace => workspace.id === root.serverProjectId) || !profile.capabilities.create || !profile.capabilities.history || !profile.capabilities.interrupt)
            throw new FSError('ECAPABILITY', 'The selected harness must support create, history and interrupt');
    } finally {await client.close();}
    const binding = {nodeConnectionId: root.connectionId, projectId, profileId: target.profileId, ...(target.selection ? {selection: target.selection} : {})};
    const id = 'project-' + (await sha256Hex(new TextEncoder().encode(JSON.stringify(binding)).buffer)).slice(0, 40);
    const existing = await service.get(id);
    if (!existing) {
        try {await service.save({id, name: `${projectId} · ${target.profileId}`, kind: 'harness', ...binding}, 0);}
        catch (error) {if ((error as {code?: string}).code !== 'ECONFLICT') throw error;}
    }
    const snapshot = await service.freeze(id);
    if (!snapshot || snapshot.nodeConnectionId !== root.connectionId || snapshot.projectId !== projectId || snapshot.profileId !== target.profileId || (snapshot.project as {serverProjectId?: string}).serverProjectId !== root.serverProjectId
        || JSON.stringify(snapshot.selection) !== JSON.stringify(target.selection)) throw new FSError('ECONFLICT', 'The project harness binding changed');
    return id;
}

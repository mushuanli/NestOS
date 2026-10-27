import { FSError } from '@itookit/vfs-core';
import type { HarnessExecutionConnection, HarnessExecutionConnectionTarget } from '@itookit/kernel-adapters/contracts';
import type { HarnessClient, HarnessProfile } from '@itookit/nestos-node-driver';
import type { ProjectFolder } from './project-service';
import type { ProjectRemoteMountService } from './remote-mounts';
import { canonical, harnessProjectIdentity } from './harness-connection-policy';
import { traceHarnessConnection } from './harness-connection-diagnostics';

type Remote = Pick<ProjectRemoteMountService, 'list' | 'resolveConnection' | 'projectHarness'>;

/** Discovery is explicit, bounded and cannot register a legacy project or create a native session. */
export async function readHarnessConnectionTargets(projects: readonly ProjectFolder[], remote?: Remote): Promise<HarnessExecutionConnectionTarget[]> {
    if (!remote) return [];
    const targets = projects.flatMap(project => {
        const root = remote.list(project.project.id).find(mount => mount.at === '/');
        return root ? [{ nodeConnectionId: root.connectionId ?? '', projectId: project.project.id,
            projectName: project.displayName ?? project.name, profiles: [], available: false } as HarnessExecutionConnectionTarget] : [];
    });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (next < targets.length) {
            const target = targets[next++];
            try { target.profiles = await traceHarnessConnection('harness.connection.targets', target.nodeConnectionId, () => readProfiles(target, remote));
                target.available = target.profiles.length > 0;
                if (!target.available) target.errorCode = 'ECAPABILITY';
            } catch (error) { target.errorCode = error instanceof FSError ? error.code : 'UNAVAILABLE'; }
        }
    }));
    return targets;
}

async function readProfiles(target: HarnessExecutionConnectionTarget, remote: Remote) {
    const definition: HarnessExecutionConnection = { id: 'discovery', name: 'discovery', kind: 'harness',
        nodeConnectionId: target.nodeConnectionId, projectId: target.projectId, profileId: 'discovery' };
    const identity = async () => harnessProjectIdentity(definition, remote.list(target.projectId), await remote.resolveConnection(target.nodeConnectionId));
    // This check precedes projectHarness, whose legacy path may otherwise register a project.
    const before = await identity(), workspaceId = (before as { serverProjectId: string }).serverProjectId;
    const client: HarnessClient = await remote.projectHarness(target.projectId, { requireRegistered: true });
    try {
        const descriptor = await client.profiles();
        if (canonical(before) !== canonical(await identity())) throw new FSError('ECONFLICT', 'Project authorization changed during discovery');
        const profiles = descriptor.profiles.filter(profile => usableProfile(profile, workspaceId));
        if (!profiles.length) throw new FSError('ECAPABILITY', 'Project has no executable harness profile');
        return profiles.map(profile => ({ id: profile.id, kind: profile.kind }));
    } finally { await client.close(); }
}

function usableProfile(profile: HarnessProfile, workspaceId: string) {
    return profile.projectRuntime && profile.workspaces.some(workspace => workspace.id === workspaceId)
        && profile.capabilities.create && profile.capabilities.history && profile.capabilities.interrupt;
}

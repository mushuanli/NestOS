import { ENTITY_ICONS, t } from '@itookit/common';
import type { HarnessProfile } from '@itookit/nestos-node-driver';
import type { ProjectRemoteMountPort } from '@itookit/app-contracts/services';
export interface RemoteHarnessAgent { id: string; name: string; description: string; source: string; icon: string; connectionId: string; profile: HarnessProfile }
/** Only verified nestos-node connections and server-advertised project harnesses appear. */
export async function listRemoteHarnessAgents(remote?: ProjectRemoteMountPort): Promise<RemoteHarnessAgent[]> {
    if (!remote) return [];
    const results = await Promise.allSettled(remote.connections().filter(c => c.projects).map(async connection => {
        const client = await remote.harness(connection.id);
        try { const result = await client.profiles({timeoutMs: 3000});
            return result.profiles.filter(profile => profile.projectRuntime).map(profile => ({
                id: 'remote:' + JSON.stringify([connection.id, profile.id]), name: `${connection.name} · ${profile.kind} · ${profile.id}`,
                description: t('harness.remoteAgents'), source: connection.name, icon: ENTITY_ICONS.remoteAgent, connectionId: connection.id, profile}));
        } finally { await client.close(); }
    }));
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

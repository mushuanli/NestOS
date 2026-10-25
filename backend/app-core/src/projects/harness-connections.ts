import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { HarnessClient, HarnessProfile } from '@itookit/mindos-node-driver';
import type { HarnessConnectionSnapshot, HarnessExecutionConnection } from '@itookit/kernel-adapters/contracts';
import type { ProjectRemoteMountService } from './remote-mounts';
import { HarnessConnectionStore, type HarnessConnectionRecord } from './harness-connection-store';
import { canonical, harnessProjectIdentity, normalizeHarnessConnection } from './harness-connection-policy';
import { traceHarnessConnection } from './harness-connection-diagnostics';
import { readHarnessConnectionTargets } from './harness-connection-targets';
import type { ProjectFolder } from './project-service';

type Remote = Pick<ProjectRemoteMountService, 'list' | 'resolveConnection' | 'projectHarness'>;
export interface HarnessConnectionAcquisition {
    client: HarnessClient; profile: HarnessProfile; workspaceId: string; epoch: string; release(): Promise<void>;
}

/** Persistent target choices are separate from node credentials and per-Task native sessions. */
export class HarnessConnectionService {
    private readonly store: HarnessConnectionStore;
    constructor(fs: IFileSystem, private readonly remote?: Remote) { this.store = new HarnessConnectionStore(fs); }
    async get(id: string): Promise<HarnessConnectionRecord | undefined> {
        const record = await this.store.get(id);
        if (!record?.connection) return;
        return { ...record, connection: normalizeHarnessConnection(record.connection) };
    }
    async list(): Promise<HarnessConnectionRecord[]> {
        return (await this.store.list()).map(record => ({ ...record, connection: normalizeHarnessConnection(record.connection!) }));
    }
    targets(projects: readonly ProjectFolder[]) { return readHarnessConnectionTargets(projects, this.remote); }
    save(connection: HarnessExecutionConnection, expectedRevision: number): Promise<HarnessConnectionRecord> {
        return traceHarnessConnection('harness.connection.save', connection?.id, async () => {
            const normalized = normalizeHarnessConnection(connection);
            return this.store.save(normalized.id, normalized, expectedRevision);
        });
    }
    remove(id: string, expectedRevision: number): Promise<HarnessConnectionRecord> {
        return traceHarnessConnection('harness.connection.remove', id, () => this.store.save(id, null, expectedRevision));
    }
    freeze(id: string): Promise<HarnessConnectionSnapshot | undefined> {
        return traceHarnessConnection('harness.connection.freeze', id, () => this.freezeConnection(id));
    }
    private async freezeConnection(id: string): Promise<HarnessConnectionSnapshot | undefined> {
        const record = await this.get(id);
        if (!record?.connection || record.connection.enabled === false) return;
        const snapshot: HarnessConnectionSnapshot = { ...record.connection, version: 1, revision: record.revision,
            project: await this.project(record.connection) };
        const acquired = await this.acquire(snapshot);
        await acquired.release();
        return snapshot;
    }
    async validate(snapshot: HarnessConnectionSnapshot): Promise<void> {
        if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw changed();
        const { version: _version, revision: _revision, project, ...definition } = snapshot;
        const normalized = normalizeHarnessConnection(definition), current = await this.get(snapshot.id);
        if (!current?.connection || current.connection.enabled === false || current.revision !== snapshot.revision
            || canonical(current.connection) !== canonical(normalized) || canonical(await this.project(normalized)) !== canonical(project)) throw changed();
    }
    acquire(snapshot: HarnessConnectionSnapshot): Promise<HarnessConnectionAcquisition> {
        return traceHarnessConnection('harness.connection.acquire', snapshot?.id, () => this.acquireConnection(snapshot));
    }
    private async acquireConnection(snapshot: HarnessConnectionSnapshot): Promise<HarnessConnectionAcquisition> {
        await this.validate(snapshot);
        const remote = this.requireRemote(), client = await remote.projectHarness(snapshot.projectId, { requireRegistered: true });
        let released: Promise<void> | undefined;
        const release = () => released ??= client.close().catch(error => {released = undefined; throw error;});
        try {
            const descriptor = await client.profiles();
            const profile = descriptor.profiles.find(item => item.id === snapshot.profileId && item.projectRuntime);
            const workspaceId = (snapshot.project as { serverProjectId?: string }).serverProjectId;
            if (!profile || !workspaceId || !profile.workspaces.some(item => item.id === workspaceId)
                || !profile.capabilities.create || !profile.capabilities.history || !profile.capabilities.interrupt)
                throw new FSError('ECAPABILITY', 'Project-scoped harness execution profile is unavailable');
            if (snapshot.selection) await validateSelection(client, profile, snapshot.selection);
            await this.validate(snapshot);
            return { client, profile: structuredClone(profile), workspaceId, epoch: descriptor.epoch, release };
        } catch (error) {
            try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Harness connection acquisition and cleanup failed'); }
            throw error;
        }
    }
    private async project(connection: HarnessExecutionConnection) {
        const remote = this.requireRemote(), node = await remote.resolveConnection(connection.nodeConnectionId);
        return harnessProjectIdentity(connection, remote.list(connection.projectId), node);
    }
    private requireRemote(): Remote {
        if (!this.remote) throw new FSError('ECAPABILITY', 'Remote harness provider is unavailable');
        return this.remote;
    }
}
async function validateSelection(client: HarnessClient, profile: HarnessProfile, selection: NonNullable<HarnessExecutionConnection['selection']>) {
    if (!profile.capabilities.models || !client.models) throw new FSError('ECAPABILITY', 'Harness model selection is unavailable');
    const model = (await client.models(profile.id)).models.find(item => item.id === selection.modelId);
    if (!model || selection.reasoningEffort && !model.reasoningEfforts.some(item => item.id === selection.reasoningEffort))
        throw new FSError('EINVAL', 'Harness model selection is unavailable');
}
function changed() { return new FSError('ECONFLICT', 'Harness execution configuration or project authorization changed'); }

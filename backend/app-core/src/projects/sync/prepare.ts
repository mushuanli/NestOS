import { OperationManager, assertSync, decimal, encodeManifest, type Coordinator, type StateStore } from '@itookit/vfs-sync';
import type { FileRemote } from '@itookit/vfs-sync';
export interface ProjectSyncPreparationRemote extends FileRemote {
    capabilities(): Promise<{ authorityId: string; namespaceId: string; historyEpoch: string }>;
    register(replica: string): Promise<{ state: string; lastAdmittedSeq: string }>;
    activate(replica: string, scopes: { projectId: string; cursor: string }[]): Promise<unknown>;
    projects(): Promise<{ projects: { projectId: string; state: string }[] }>;
}

/** Register a fresh replica and create only the explicitly requested project/dataset. */
export async function prepareProjectSync(store: StateStore, remote: ProjectSyncPreparationRemote, coordinator: Coordinator,
    newId: () => string, createProject = false): Promise<void> {
    const state = await store.read(), b = state.binding, caps = await remote.capabilities();
    assertSync(caps.authorityId === b.authorityId && caps.namespaceId === b.namespaceId && caps.historyEpoch === b.historyEpoch, 'SYNC_IDENTITY_CHANGED');
    const registered = await remote.register(b.replicaId);
    assertSync(registered.state !== 'expired', 'NEW_REPLICA_REQUIRED');
    const prior = decimal(state.nextSeq) - 1n, admitted = decimal(registered.lastAdmittedSeq);
    assertSync(admitted === prior || (state.pending && admitted + 1n === prior), 'OPERATION_SEQUENCE_RECONCILIATION');
    const listing = await remote.projects();
    const project = listing.projects.find(p => p.projectId === b.projectId);
    if (registered.state === 'reconciling') {
        const scope = project ?? listing.projects[0];
        const scopes = scope ? [{ projectId: scope.projectId, cursor: await catalogCursor(remote, scope.projectId) }] : [];
        await remote.activate(b.replicaId, scopes);
    }
    const operations = new OperationManager(store, remote, coordinator, newId);
    if (!project) {
        assertSync(createProject, 'PROJECT_NOT_FOUND');
        const created = await operations.execute('projects', { projectId: b.projectId });
        assertSync(created.outcome === 'committed', created.code ?? 'PROJECT_CREATE_FAILED');
    } else assertSync(project.state === 'active', 'PROJECT_DELETED');
    await prepareDataset(store, remote, operations);
}
async function catalogCursor(remote: ProjectSyncPreparationRemote, projectId: string): Promise<string> {
    let cursor: string | undefined, result: { cursor: string; nextCursor: string | null };
    do { result = await remote.catalog(projectId, cursor) as typeof result; cursor = result.nextCursor ?? undefined; } while (cursor);
    return result.cursor;
}
async function prepareDataset(store: StateStore, remote: ProjectSyncPreparationRemote, operations: OperationManager): Promise<void> {
    const b = (await store.read()).binding;
    let cursor: string | undefined, found = false;
    do {
        const catalog = await remote.catalog(b.projectId, cursor) as { datasets: { datasetId: string; kind: string; state: string }[]; nextCursor: string | null };
        const match = catalog.datasets.find(d => d.datasetId === b.datasetId);
        if (match) { assertSync(match.kind === 'files' && match.state === 'active', 'DATASET_INCOMPATIBLE'); found = true; }
        cursor = catalog.nextCursor ?? undefined;
    } while (cursor);
    if (found) return;
    const project = await remote.project(b.projectId);
    const manifestHash = await remote.upload(b.projectId, encodeManifest({ format: 'fs-agent.files', version: 1, entries: [] }));
    const receipt = await operations.execute(`projects/${b.projectId}/datasets`, { datasetId: b.datasetId, kind: 'files',
        logicalId: b.datasetId, manifestHash, expectedProjectLifecycleRevision: project.lifecycleRevision });
    assertSync(receipt.outcome === 'committed', receipt.code ?? 'DATASET_CREATE_FAILED');
}

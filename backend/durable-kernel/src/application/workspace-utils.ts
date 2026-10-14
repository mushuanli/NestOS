// @file: durable-kernel/src/application/workspace-utils.ts
// 工作区快照 / diff / merge 的纯辅助。

import type {
    JsonValue,
    ProgramRef,
    ResourceRecord,
    WorkspaceExecutionContext,
    WorkspaceSnapshot,
} from '../domain/types';
import { createId, type SeqFileKernelStore } from '../infrastructure/seqfile/store';
import type { ResolvedStorageBinding } from '../domain/types';

export function workspaceContext(
    sessionId: string,
    resource: ResourceRecord,
): WorkspaceExecutionContext {
    return { sessionId, resource, abortSignal: new AbortController().signal };
}

export function workspaceSnapshot(
    sessionId: string,
    resourceId: string,
    adapter: ProgramRef,
    payload: JsonValue,
    parentIds: string[] = [],
): WorkspaceSnapshot {
    return {
        id: createId('workspace-snapshot'), sessionId, resourceId,
        adapter, parentIds, payload, createdAt: Date.now(),
    };
}

export async function readWorkspaceSnapshots(
    store: SeqFileKernelStore,
    binding: ResolvedStorageBinding,
    ids: string[],
): Promise<WorkspaceSnapshot[]> {
    return Promise.all(ids.map(id => store.getWorkspaceSnapshot(binding, id)));
}

export function assertWorkspace(resource: ResourceRecord): void {
    if (resource.kind !== 'workspace') {
        throw new Error(`Resource is not a workspace: ${resource.id}`);
    }
}

export function assertWorkspaceSnapshots(
    resource: ResourceRecord,
    ...snapshots: WorkspaceSnapshot[]
): void {
    assertWorkspace(resource);
    for (const snapshot of snapshots) {
        if (snapshot.sessionId !== resource.sessionId || snapshot.resourceId !== resource.id) {
            throw new Error(`Workspace snapshot does not belong to resource: ${snapshot.id}`);
        }
        const expected = snapshots[0].adapter;
        if (snapshot.adapter.kind !== expected.kind || snapshot.adapter.version !== expected.version) {
            throw new Error(`Workspace snapshot adapter mismatch: ${snapshot.id}`);
        }
    }
}

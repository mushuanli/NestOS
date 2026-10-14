import { decodeSchedulerCheckpoint } from './checkpoint-decoder';
import type { JsonValue, SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import type { FlowWorkspacePolicy } from '../contracts';
import type { SchedulerLease } from './scheduler-lease';
import { beginWorkspaceFinalization, workspaceFinalizationKey, type WorkspaceFinalization } from './workspace-finalization';
import { instanceKey } from './node-instance';

export interface FlowWorkspaceLease {
    directory: string;
    /**
     * JSON-serializable description of the lease. The executor persists it so a new
     * host can restore the same workspace after a crash instead of creating a second one.
     */
    record?: JsonValue;
    /** Host barrier: all file/process capabilities must be closed before filesystem cleanup. */
    releaseCapabilities?(rootTaskId: string): Promise<void>;
    finish(status: 'succeeded' | 'failed' | 'cancelled'): Promise<void | { message: string }>;
}

export interface FlowWorkspaceManager {
    prepare(sessionId: string, policy: FlowWorkspacePolicy): Promise<FlowWorkspaceLease>;
    /** Re-attach to a workspace whose lease was persisted by `record` before a crash. */
    restore?(sessionId: string, policy: FlowWorkspacePolicy, record: JsonValue, options?: FlowWorkspaceRestoreOptions): Promise<FlowWorkspaceLease>;
}

export interface FlowWorkspaceRestoreOptions {
    /** A terminal Run is only completing cleanup; no node may execute in the restored workspace. */
    forFinalization?: boolean;
}

/** Session shared key holding the durable workspace lease record of a Run. */
export const workspaceLeaseKey = (rootTaskId: string): string => `flow.run.${rootTaskId}.workspace-lease`;
/** Workspace and detached-task lifecycle; the caller supplies fenced sessions and leases. */
export class FlowRunLifecycle {
    constructor(private readonly options: { manager?: FlowWorkspaceManager; isDisposed(): boolean }) {}

    /** Finish a workspace finalization that a previous host started but did not complete. */
    async resumeWorkspaceFinalization(
        session: SessionHandle,
        root: TaskHandle<JsonValue>,
        rootTaskId: string,
    ): Promise<void> {
        const state = (await session.getShared(workspaceFinalizationKey(rootTaskId)))?.value as
            WorkspaceFinalization | undefined;
        if (state?.status === 'succeeded') return;
        const initial = record((await root.status()).task.input).initialScheduler;
        const checkpoint = decodeSchedulerCheckpoint((await session.getShared(`flow.run.${rootTaskId}.scheduler`))?.value ?? initial);
        const policy = checkpoint?.spec.runPolicy?.workspace;
        if (!policy || policy.mode === 'shared') return;
        const workspace = await this.restoreWorkspace(session, rootTaskId, policy, { forFinalization: true });
        await (await beginWorkspaceFinalization(session, root, workspace)).completion;
    }

    async restoreWorkspace(
        session: SessionHandle,
        rootTaskId: string,
        policy: FlowWorkspacePolicy,
        options?: FlowWorkspaceRestoreOptions,
    ): Promise<FlowWorkspaceLease> {
        if (!this.options.manager?.restore) {
            throw new Error(`Resuming an isolated Flow workspace requires a workspace manager that restores leases`);
        }
        const saved = await session.getShared(workspaceLeaseKey(rootTaskId));
        const value = saved?.value ?? record((await (await session.attachTask(rootTaskId)).status()).task.input).initialWorkspace;
        if (value === undefined) throw new Error('Flow workspace lease record is missing');
        if (!saved) await session.setShared(workspaceLeaseKey(rootTaskId), jsonValue(value));
        return this.options.manager.restore(session.id, policy, jsonValue(value), options);
    }

    /** Keep local ownership until bounded detached work stops or the host shuts down. */
    async drainDetached(session: SessionHandle, rootTaskId: string, lease: SchedulerLease): Promise<void> {
        const saved = await session.getShared(`flow.run.${rootTaskId}.scheduler`);
        const checkpoint = decodeSchedulerCheckpoint(saved?.value);
        const instances = new Map(checkpoint?.instances);
        const pending = await Promise.all((checkpoint?.delegationGroups ?? [])
            .filter(([, group]) => group.detached)
            .flatMap(([id, group]) => [...group.children].flatMap(child => (instances.get(child) ?? [])
                .map(async taskId => ({ id, deadline: group.deadline, task: await session.attachTask(taskId) })))));
        while (pending.length && !this.options.isDisposed()) {
            await lease.assertOwned();
            for (let index = pending.length - 1; index >= 0; index--) {
                const item = pending[index];
                if (item.deadline && Date.now() >= item.deadline) await item.task.cancel(`Detached delegation timeout: ${item.id}`);
                if (await item.task.poll()) pending.splice(index, 1);
            }
            if (pending.length) await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    async prepareWorkspace(sessionId: string, policy: FlowWorkspacePolicy): Promise<FlowWorkspaceLease> {
        if (!this.options.manager) {
            throw new Error(`Flow workspace mode ${policy.mode} requires a configured workspace manager`);
        }
        return this.options.manager.prepare(sessionId, policy);
    }

    async finalizeWorkspace(session: SessionHandle,
        run: { root: TaskHandle<JsonValue>; workspaceCompletion?: Promise<void>; workspaceFinalization?: WorkspaceFinalization },
        workspace: FlowWorkspaceLease): Promise<void> {
        const finalization = await beginWorkspaceFinalization(session, run.root, workspace);
        run.workspaceCompletion = finalization.completion;
        run.workspaceFinalization = finalization.state;
        // Keep ownership until cleanup is recorded; consumers observe the original promise.
        await run.workspaceCompletion.catch(() => undefined);
    }

    async cleanupFailedSubmission(instances: Map<string, TaskHandle[]>, completed: Set<string>,
        workspace: FlowWorkspaceLease | undefined, error: unknown, rootTaskId?: string): Promise<unknown> {
        try {
            await cancelPendingFlowTasks(instances, completed, 'Flow submission failed');
            if (rootTaskId) await workspace?.releaseCapabilities?.(rootTaskId);
            await workspace?.finish('failed');
            return error;
        } catch (cleanupError) {
            return new AggregateError([error, cleanupError], 'Flow failed and workspace cleanup failed');
        }
    }
}

export async function cancelPendingFlowTasks(
    instances: Map<string, TaskHandle[]>,
    completed: Set<string>,
    reason: string,
): Promise<void> {
    const cancellations: Promise<void>[] = [];
    for (const [nodeId, handles] of instances) {
        for (const [index, handle] of handles.entries()) {
            if (!completed.has(instanceKey(nodeId, index + 1))) cancellations.push(handle.cancel(reason));
        }
    }
    const results = await Promise.allSettled(cancellations);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures,
        `Flow task cancellation failed: ${failures.map(String).join('; ')}`);
}

function record(value: unknown): Record<string, JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function jsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

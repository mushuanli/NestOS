import { waitForFlowRunTasks, type FlowWorkspaceLease, type FlowWorkspaceManager } from '@itookit/llm-flow';
import type { HeadlessKernelRuntime } from './create-kernel-runtime';
import {managedWorkspaceLease, registerWorkspaceResource} from './workspace-resource';

/** Preserve host workspace behavior while closing its Run capabilities before finish mutates files. */
export function withWorkspaceScopeCleanup(manager: FlowWorkspaceManager, runtime: HeadlessKernelRuntime,
    canWrite?: (sessionId: string) => Promise<boolean>): FlowWorkspaceManager {
    if (manager.restore) registerWorkspaceResource({manager, runtime, canWrite});
    const bind = (sessionId: string, lease: FlowWorkspaceLease): FlowWorkspaceLease => {
        const scoped: FlowWorkspaceLease = {
            ...lease,
            releaseCapabilities: async rootId => {
                const session = await runtime.kernel.openSession(sessionId);
                await waitForFlowRunTasks(session, rootId);
                await runtime.disposeScope(sessionId, rootId);
                await lease.releaseCapabilities?.(rootId);
            },
        };
        return manager.restore && lease.record !== undefined ? managedWorkspaceLease(sessionId, scoped, runtime.kernel) : scoped;
    };
    return {
        prepare: async (sessionId, policy) => bind(sessionId, await manager.prepare(sessionId, policy)),
        ...(manager.restore ? { restore: async (sessionId, policy, record, options) =>
            bind(sessionId, await manager.restore!(sessionId, policy, record, options)) } satisfies Pick<FlowWorkspaceManager, 'restore'> : {}),
    };
}

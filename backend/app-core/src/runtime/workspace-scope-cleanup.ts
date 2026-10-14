import { waitForFlowRunTasks, type FlowWorkspaceLease, type FlowWorkspaceManager } from '@itookit/llm-flow';
import type { HeadlessKernelRuntime } from './create-kernel-runtime';

/** Preserve host workspace behavior while closing its Run capabilities before finish mutates files. */
export function withWorkspaceScopeCleanup(manager: FlowWorkspaceManager, runtime: HeadlessKernelRuntime): FlowWorkspaceManager {
    const bind = (sessionId: string, lease: FlowWorkspaceLease): FlowWorkspaceLease => ({
        ...lease,
        releaseCapabilities: async rootId => {
            const session = await runtime.kernel.openSession(sessionId);
            await waitForFlowRunTasks(session, rootId);
            await runtime.disposeScope(sessionId, rootId);
            await lease.releaseCapabilities?.(rootId);
        },
    });
    return {
        prepare: async (sessionId, policy) => bind(sessionId, await manager.prepare(sessionId, policy)),
        ...(manager.restore ? { restore: async (sessionId, policy, record, options) =>
            bind(sessionId, await manager.restore!(sessionId, policy, record, options)) } satisfies Pick<FlowWorkspaceManager, 'restore'> : {}),
    };
}

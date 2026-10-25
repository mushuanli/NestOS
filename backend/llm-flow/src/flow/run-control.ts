import type {SessionHandle, TaskControl, TaskRecord} from '@itookit/durable-kernel';
import {assertFlowControlTree, flowControlError, hasFlowControlTree} from './control-tree';
import {assertCurrentFlowControl} from './control-tree';
export {assertCurrentFlowControl} from './control-tree';
import {recoverLegacyFlowPause, type FlowControlRecovery} from './legacy-control';

/** Kernel owns tree holds; changing a Run must not overwrite a member's independent control. */
export async function controlFlowRun(session: SessionHandle, rootId: string, status: 'paused' | 'active', requestId: string,
    expectedEpoch?: number): Promise<FlowControlRecovery & {control?: TaskControl}> {
    const handle = await session.attachTask(rootId), root = (await handle.status()).task;
    assertFlowRoot(root, rootId);
    if (!hasFlowControlTree(root)) {
        if (status === 'paused') assertFlowControlTree(root);
        return recoverLegacyFlowPause(session, root, requestId, expectedEpoch);
    }
    const control = status === 'paused' ? await handle.pause({requestId, expectedEpoch}) : await handle.resume({requestId, expectedEpoch});
    assertCurrentFlowControl((await handle.status()).task, control);
    return {control};
}

export function assertFlowRoot(root: TaskRecord, rootId: string): void {
    if (root.id !== rootId || root.program.kind !== 'flow.aggregate' || root.labels?.kind !== 'flow-root')
        throw flowControlError('FLOW_CONTROL_ROOT_INVALID', 'Control target is not the owning Flow root');
}

export function assertPauseWithdrawal(input: {requestId: string; expectedEpoch: number}): void {
    if (typeof input.requestId !== 'string' || !input.requestId.trim()
        || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0)
        throw flowControlError('FLOW_CONTROL_REQUEST_INVALID', 'Pause withdrawal requires requestId and the observed control epoch');
}

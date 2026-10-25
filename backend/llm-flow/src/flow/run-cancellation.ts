import type {Kernel} from '@itookit/durable-kernel';
import type {FlowCancellationQuery, FlowCancellationRequest} from '../contracts/flow-control';
import {withFlowControl} from './control-session';
import {assertFlowRoot} from './run-control';
import {assertFlowControlTree, flowControlError} from './control-tree';
import {traceFlowRunControl, type FlowControlDiagnostic} from './control-diagnostics';

interface Options {kernel: Kernel; canWriteSession?(id: string): Promise<boolean>; onControlDiagnostic?(event: FlowControlDiagnostic): void}

/** Explicit-scope cancellation needs no cached Run handle and keeps the scheduler fence. */
export function cancelFlowRun(options: Options, supplied: FlowCancellationRequest) {
    const input = structuredClone(supplied);
    return traceFlowRunControl({requestId: input?.requestId, sessionId: input?.sessionId, rootTaskId: input?.taskId, mode: 'cancel'},
        options.onControlDiagnostic, async () => {
            validateQuery(input, true);
            assertFlowControlTree(await inspectRoot(options.kernel, input));
            return withFlowControl(options.kernel, input.sessionId, input.taskId, options.canWriteSession, async session => {
                const task = await session.attachTask(input.taskId), root = (await task.status()).task;
                assertFlowRoot(root, input.taskId); assertFlowControlTree(root);
                await task.cancel('Cancelled from Flow control', {requestId: input.requestId, expectedEpoch: input.expectedEpoch});
                const receipt = await options.kernel.readTaskCancellationReceipt(input.sessionId, input.taskId, input.requestId);
                if (!receipt) throw flowControlError('FLOW_CANCEL_RECEIPT_MISSING', 'Cancellation admission is unavailable');
                return {taskId: input.taskId, cancelled: receipt.status === 'cancelled', receipt};
            });
        });
}

/** A separate intent: preserve a completed root and stop only its remaining work. */
export function cancelRemainingFlowRun(options: Options, supplied: FlowCancellationRequest) {
    const input = structuredClone(supplied);
    return traceFlowRunControl({requestId: input?.requestId, sessionId: input?.sessionId, rootTaskId: input?.taskId, mode: 'cancel-remaining'},
        options.onControlDiagnostic, async () => {
            validateQuery(input, true);
            assertFlowControlTree(await inspectRoot(options.kernel, input));
            return withFlowControl(options.kernel, input.sessionId, input.taskId, options.canWriteSession, async (_session, lease) => {
                assertFlowControlTree(await inspectRoot(options.kernel, input));
                await options.kernel.cancelRemainingTaskTree(input.sessionId, input.taskId, {
                    requestId: input.requestId, expectedEpoch: input.expectedEpoch, lease,
                });
                const receipt = await options.kernel.readTaskTreeCancellationReceipt(input.sessionId, input.taskId, input.requestId);
                if (!receipt) throw flowControlError('FLOW_TREE_CANCEL_RECEIPT_MISSING', 'Remaining-tree cancellation admission is unavailable');
                return {taskId: input.taskId, receipt};
            });
        });
}

/** Reads admission even while the original command is waiting for adapter cleanup. */
export async function readFlowTreeCancellationReceipt(kernel: Kernel, supplied: FlowCancellationQuery) {
    const input = structuredClone(supplied); validateQuery(input, false);
    await inspectRoot(kernel, input);
    return kernel.readTaskTreeCancellationReceipt(input.sessionId, input.taskId, input.requestId);
}

/** Inspection does not take a scheduler lease or reconstruct a running handle. */
export async function readFlowCancellationReceipt(kernel: Kernel, supplied: FlowCancellationQuery) {
    const input = structuredClone(supplied); validateQuery(input, false);
    await inspectRoot(kernel, input);
    return kernel.readTaskCancellationReceipt(input.sessionId, input.taskId, input.requestId);
}

function validateQuery(input: FlowCancellationQuery, write: boolean): void {
    const allowed = ['sessionId', 'taskId', 'requestId', ...(write ? ['expectedEpoch'] : [])];
    const epoch = (input as FlowCancellationRequest)?.expectedEpoch;
    if (!input || ['sessionId', 'taskId', 'requestId'].some(key => typeof input[key as keyof FlowCancellationQuery] !== 'string'
        || !input[key as keyof FlowCancellationQuery].trim()) || Object.keys(input).some(key => !allowed.includes(key))
        || write && (!Number.isSafeInteger(epoch) || epoch < 0))
        throw flowControlError('FLOW_CONTROL_REQUEST_INVALID', 'Cancellation requires explicit Session, root, request and control epoch');
}

async function inspectRoot(kernel: Kernel, input: FlowCancellationQuery) {
    const session = await kernel.inspectSession(input.sessionId), root = (await (await session.attachTask(input.taskId)).status()).task;
    assertFlowRoot(root, input.taskId); return root;
}

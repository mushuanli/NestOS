import type { TaskControl, TaskRecord } from '@itookit/durable-kernel';
import {hasFlowControlTree} from '../contracts/flow-control';
export {hasFlowControlTree} from '../contracts/flow-control';

export function flowTaskHeld(task: TaskRecord): boolean {
    return !!task.sessionPaused || !!task.controlHolds?.length || !!task.control && task.control.mode !== 'run';
}

export function flowControlError(code: string, message: string): Error & {code: string} {
    return Object.assign(new Error(message), {code});
}

export function assertFlowControlTree(root: TaskRecord): void {
    if (!hasFlowControlTree(root)) throw flowControlError('FLOW_CONTROL_TREE_UNAVAILABLE',
        'This legacy Run has no task control tree; use its legacy control entry');
}

/** Only the specific parent admission conflict is safe to retry with an unchanged request. */
export function isPausedParentAdmission(error: unknown): boolean {
    return error instanceof Error && (error as {code?: string}).code === 'CONFLICT'
        && error.message === 'Parent is not accepting children';
}

export function assertLiveFlowRoot(root: TaskRecord): void {
    if (root.exit || ['succeeded', 'failed', 'cancelled'].includes(root.status))
        throw flowControlError('FLOW_RUN_TERMINAL', 'Flow run ended before this node was admitted');
}

export function assertCurrentFlowControl(root: TaskRecord, receipt: TaskControl): void {
    const current = root.control;
    if (!current || current.epoch !== receipt.epoch || current.requestId !== receipt.requestId || current.mode !== receipt.mode)
        throw flowControlError('FLOW_CONTROL_SUPERSEDED', 'The control receipt was superseded; refresh the Run before another action');
}

export function assertFlowControlCheckpoint(root: TaskRecord, version: 1 | undefined): void {
    if (hasFlowControlTree(root) !== (version === 1)) throw flowControlError('FLOW_CONTROL_TREE_MISMATCH',
        'The saved control protocol differs from the frozen Run; restore its original checkpoint');
}

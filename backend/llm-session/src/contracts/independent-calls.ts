import type {TaskStat} from '@itookit/durable-kernel/contracts';
import type {SubmissionRequest, SubmissionReceipt} from './submission';
import type {TransferReference} from './content-transfer';
import type {ExecutionRef} from './conversation';

export const IndependentCallCommand = {Submit: 'session.call.submit', Inspect: 'session.call.inspect', List: 'session.calls.list',
    Cancel: 'session.call.cancel', CancellationReceipt: 'session.call.cancellation.receipt',
    Control: 'session.call.control', ControlReceipt: 'session.call.control.receipt'} as const;
/** Caller identity and selected materials; ancestry alone never imports conversation history. */
export interface IndependentCallInput {request: SubmissionRequest; title: string; transfer?: TransferReference}
export interface IndependentCallReceipt extends SubmissionReceipt {
    callerSessionId: string;
    executionSessionId?: string;
    execution?: ExecutionRef;
}
/** The host leases a separate execution context without rebinding the caller's view. */
export type IndependentCallSubmitter = (request: SubmissionRequest) => Promise<string>;

export interface IndependentCallListQuery {sessionId: string; branchId?: string}
/** Primary Task facts only; not an aggregate stop/settlement acknowledgement for its children. */
export type IndependentCallExecutionState = Pick<TaskStat, 'id' | 'revision' | 'phase' | 'control' | 'blockedBy' | 'activeOperations' | 'settled' | 'stopped'> & {controlEpoch: number};
export interface IndependentCallView {
    input: IndependentCallInput;
    receipt: IndependentCallReceipt;
    createdAt: number;
    head: string | null;
    status?: import('./conversation').Round['status'];
    executionState?: IndependentCallExecutionState;
    /** Bounded pending interaction summaries belonging to this execution tree. */
    interactions?: IndependentCallInteractions;
    /** Protocol support only; current write permission is revalidated on control. */
    controlCapabilities?: {cancel: boolean; pause?: 'boundary' | 'none'; resume?: boolean; withdrawPause?: boolean};
    /** Bounded display text only; execution consumers read the actual child output. */
    summary?: string;
}


/** All identities are verified against the persisted call route and its primary execution. */
export interface IndependentCallControlQuery {
    sessionId: string; branchId: string; callId: string; executionSessionId: string; taskId: string; requestId: string;
}
export interface IndependentCallCancelRequest extends IndependentCallControlQuery {expectedEpoch: number}
export interface IndependentCallCancellationReceipt extends IndependentCallControlQuery {
    /** Admission evidence only; absence means unknown, never permission to resubmit. */
    receipt?: import('@itookit/durable-kernel/contracts').TaskCancellationReceipt;
}


export type IndependentCallControlAction = 'pause' | 'resume' | 'withdraw';
export interface IndependentCallStateControlQuery extends IndependentCallControlQuery {action: IndependentCallControlAction}
export interface IndependentCallStateControlRequest extends IndependentCallStateControlQuery {expectedEpoch: number}
export interface IndependentCallStateControlReceipt extends IndependentCallStateControlQuery {
    /** Original admission, distinct from the latest acknowledgement or active control. */
    receipt?: import('@itookit/durable-kernel/contracts').TaskControlReceipt;
}

export interface IndependentCallInteractions {
    total: number;
    items: Array<{taskId: string; interactionId: string; kind: 'input' | 'approval'; prompt: string; promptTruncated: boolean; requestedAt: number}>;
}

import type {TaskStat} from '@itookit/durable-kernel/contracts';
import type {SubmissionRequest, SubmissionReceipt} from './submission';
import type {TransferReference} from './content-transfer';
import type {ExecutionRef} from './conversation';

export const IndependentCallCommand = {Submit: 'session.call.submit', Inspect: 'session.call.inspect', List: 'session.calls.list'} as const;
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
    /** Bounded display text only; execution consumers read the actual child output. */
    summary?: string;
}

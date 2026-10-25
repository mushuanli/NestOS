import type {SubmissionRequest, SubmissionReceipt} from './submission';
import type {TransferReference} from './content-transfer';
import type {ExecutionRef} from './conversation';

export const IndependentCallCommand = {Submit: 'session.call.submit', Inspect: 'session.call.inspect'} as const;
/** Caller identity and selected materials; ancestry alone never imports conversation history. */
export interface IndependentCallInput {request: SubmissionRequest; title: string; transfer?: TransferReference}
export interface IndependentCallReceipt extends SubmissionReceipt {
    callerSessionId: string;
    executionSessionId?: string;
    execution?: ExecutionRef;
}
/** The host leases a separate execution context without rebinding the caller's view. */
export type IndependentCallSubmitter = (request: SubmissionRequest) => Promise<string>;

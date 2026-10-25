import {createModuleLogger} from '@itookit/common';
import type {OperationLedger, OperationRecord, OperationReceipt} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallCancelRequest, type IndependentCallCancellationReceipt, type ICommandBus} from '@itookit/llm-session/contracts';
import {canonicalJson} from '../utils/canonical-json';

export const callCancellationProtocol = 'independent-call-cancel-v1';
interface Frozen {protocol: typeof callCancellationProtocol; request: IndependentCallCancelRequest}
const log = createModuleLogger('independent-call-control');

/** Freeze one control intent in the existing ledger; recovery only reads its original receipt. */
export class CallCancellationOperations {
    constructor(private ledger: OperationLedger, private commands: ICommandBus, private sessionId: string) {}
    has(id: string): boolean {return this.ledger.getSnapshot().some(record => record.context.operationId === id && this.owns(record));}
    latest(branchId: string, callId: string, taskId: string): OperationRecord | undefined {
        const matches = [...this.ledger.getSnapshot()].reverse().filter(record => this.owns(record)
            && (record.input as unknown as Frozen).request.branchId === branchId
            && (record.input as unknown as Frozen).request.callId === callId && (record.input as unknown as Frozen).request.taskId === taskId);
        return matches.find(record => ['submitting', 'unknown'].includes(record.status)) ?? matches[0];
    }
    async cancel(input: IndependentCallCancelRequest, current: () => boolean): Promise<OperationReceipt> {
        const request = structuredClone(input), operationId = request.requestId, started = Date.now();
        if (request.sessionId !== this.sessionId) throw failure('CALL_CONTROL_SCOPE_MISMATCH');
        const previous = this.ledger.getSnapshot().find(record => record.context.operationId === operationId);
        if (previous) {
            if (!this.owns(previous) || canonicalJson((previous.input as unknown as Frozen).request) !== canonicalJson(request)) throw failure('CALL_CONTROL_IDENTITY_MISMATCH');
            return this.reconcile(operationId);
        }
        try {
            await this.ledger.register({context: {operationId, viewId: 'independent-call-control'}, conversationId: this.sessionId,
                kind: 'command', status: 'submitting', input: {protocol: callCancellationProtocol, request} as unknown as OperationRecord['input']});
        } catch {
            log.warn('call.cancel', {operationId, stage: 'register', result: 'failure', code: 'CALL_CONTROL_SAVE_FAILED', durationMs: Date.now() - started});
            throw failure('CALL_CONTROL_SAVE_FAILED');
        }
        if (!current()) {
            const receipt: OperationReceipt = {operationId, status: 'rejected', code: 'CALL_VIEW_CLOSED', message: 'Cancellation was not sent before the view closed'};
            await this.ledger.settle(receipt); return receipt;
        }
        return this.observe(request, true);
    }
    async reconcile(operationId: string): Promise<OperationReceipt> {
        const record = this.ledger.getSnapshot().find(value => value.context.operationId === operationId);
        if (!record || !this.owns(record)) throw failure('CALL_CONTROL_RECORD_MISSING');
        if (record.status === 'accepted') return {operationId, status: 'accepted'};
        if (record.status === 'rejected') return {operationId, status: 'rejected', code: 'CALL_CONTROL_REJECTED', message: record.message ?? 'Cancellation was rejected'};
        return this.observe((record.input as unknown as Frozen).request, false);
    }
    private async observe(request: IndependentCallCancelRequest, write: boolean): Promise<OperationReceipt> {
        const started = Date.now(), operationId = request.requestId, stage = write ? 'dispatch' : 'receipt';
        try {
            const {expectedEpoch: _epoch, ...query} = request;
            const result = await this.commands.execute<IndependentCallCancellationReceipt>(write ? IndependentCallCommand.Cancel : IndependentCallCommand.CancellationReceipt, write ? request : query);
            if (!result || Object.entries(query).some(([key, value]) => result[key as keyof typeof query] !== value)
                || result.receipt && (result.receipt.requestId !== operationId || result.receipt.taskId !== request.taskId
                    || result.receipt.expectedEpoch !== request.expectedEpoch || !['succeeded', 'failed', 'cancelled'].includes(result.receipt.status)))
                throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
            const receipt: OperationReceipt = result.receipt ? {operationId, status: 'accepted'}
                : {operationId, status: 'unknown', message: 'No retained cancellation admission; query the original request'};
            if (this.ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status !== receipt.status)
                await this.ledger.settle(receipt);
            log.info('call.cancel', {operationId, stage, result: receipt.status, durationMs: Date.now() - started}); return receipt;
        } catch (error) {
            log.warn('call.cancel', {operationId, stage, result: 'failure', code: safeCode(error), durationMs: Date.now() - started});
            if (this.ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status === 'accepted') return {operationId, status: 'accepted'};
            if (write) await this.ledger.settle({operationId, status: 'unknown', message: 'Query the original cancellation receipt'});
            throw error;
        }
    }
    private owns(record: OperationRecord): boolean {
        const input = record.input as unknown as Partial<Frozen> | null, request = input?.request;
        return record.kind === 'command' && record.conversationId === this.sessionId && input?.protocol === callCancellationProtocol
            && request?.sessionId === this.sessionId && request.requestId === record.context.operationId;
    }
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
export function cancellationErrorCode(error: unknown): string {return safeCode(error);}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_CONTROL_FAILED';
}

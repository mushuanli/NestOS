import {createModuleLogger} from '@itookit/common';
import type {OperationLedger, OperationRecord, OperationReceipt} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallCancelRemainingRequest, type IndependentCallTreeCancellationReceipt, type IndependentCallCancelRequest, type IndependentCallCancellationReceipt, type IndependentCallStateControlRequest, type IndependentCallStateControlReceipt, type IndependentCallResponseRequest, type IndependentCallResponseReceipt, type ICommandBus} from '@itookit/llm-session/contracts';
import {canonicalJson} from '../utils/canonical-json';

export const callTreeCancellationProtocol = 'independent-call-tree-cancel-v1';
export const callCancellationProtocol = 'independent-call-cancel-v1';
export const callStateControlProtocol = 'independent-call-state-v1';
export const callResponseProtocol = 'independent-call-response-v1';
type Request = IndependentCallCancelRequest | IndependentCallStateControlRequest | IndependentCallResponseRequest;
type Result = IndependentCallTreeCancellationReceipt | IndependentCallCancellationReceipt | IndependentCallStateControlReceipt | IndependentCallResponseReceipt;
interface Frozen {protocol: string; request: Request}
const protocol = (request: Request) => 'interactionId' in request ? callResponseProtocol : 'action' in request ? callStateControlProtocol : callCancellationProtocol;
const controlCommands: Record<string, readonly [string, string]> = {
    [callCancellationProtocol]: [IndependentCallCommand.Cancel, IndependentCallCommand.CancellationReceipt],
    [callTreeCancellationProtocol]: [IndependentCallCommand.CancelRemaining, IndependentCallCommand.TreeCancellationReceipt],
    [callStateControlProtocol]: [IndependentCallCommand.Control, IndependentCallCommand.ControlReceipt],
    [callResponseProtocol]: [IndependentCallCommand.Respond, IndependentCallCommand.ResponseReceipt],
};
const log = createModuleLogger('independent-call-control');

/** Freeze one control intent in the existing ledger; recovery only reads its original receipt. */
export class CallControlOperations {
    constructor(private ledger: OperationLedger, private commands: ICommandBus, private sessionId: string) {}
    has(id: string): boolean {return this.ledger.getSnapshot().some(record => record.context.operationId === id && this.owns(record));}
    latest(branchId: string, callId: string, taskId: string, channel: 'cancel' | 'state' | 'remaining' = 'cancel', targetTaskId?: string): OperationRecord | undefined {
        const matches = [...this.ledger.getSnapshot()].reverse().filter(record => this.owns(record)
            && (record.input as unknown as Frozen).protocol === ({cancel: callCancellationProtocol, state: callStateControlProtocol, remaining: callTreeCancellationProtocol}[channel])
            && (record.input as unknown as Frozen).request.branchId === branchId
            && (record.input as unknown as Frozen).request.callId === callId && (record.input as unknown as Frozen).request.taskId === taskId
            && ((record.input as unknown as Frozen).request as IndependentCallCancelRequest).targetTaskId === targetTaskId);
        return matches.find(record => ['submitting', 'unknown'].includes(record.status)) ?? matches[0];
    }
    pendingCancellationTargets(branchId: string, callId: string, taskId: string): string[] {
        const targets = this.ledger.getSnapshot().flatMap(record => {
            const frozen = record.input as unknown as Frozen, request = frozen?.request as IndependentCallCancelRequest;
            return this.owns(record) && frozen.protocol === callCancellationProtocol && ['submitting', 'unknown'].includes(record.status)
                && request.branchId === branchId && request.callId === callId && request.taskId === taskId && request.targetTaskId ? [request.targetTaskId] : [];
        });
        return [...new Set(targets)];
    }
    async cancel(input: IndependentCallCancelRequest, current: () => boolean): Promise<OperationReceipt> {
        return this.submit(input, current);
    }
    cancelRemaining(input: IndependentCallCancelRemainingRequest, current: () => boolean): Promise<OperationReceipt> {
        return this.submit(input, current, callTreeCancellationProtocol);
    }
    control(input: IndependentCallStateControlRequest, current: () => boolean): Promise<OperationReceipt> {return this.submit(input, current);}
    respond(input: IndependentCallResponseRequest, current: () => boolean): Promise<OperationReceipt> {return this.submit(input, current);}
    answers(branchId: string, callId: string, taskId: string): OperationRecord[] {
        return this.ledger.getSnapshot().filter(record => {
            const frozen = record.input as unknown as Frozen;
            return this.owns(record) && frozen.protocol === callResponseProtocol && frozen.request.branchId === branchId
                && frozen.request.callId === callId && frozen.request.taskId === taskId;
        });
    }
    private async submit(input: Request, current: () => boolean, kind = protocol(input)): Promise<OperationReceipt> {
        const request = structuredClone(input), frozen = {protocol: kind, request}, operationId = request.requestId, started = Date.now();
        if (request.sessionId !== this.sessionId) throw failure('CALL_CONTROL_SCOPE_MISMATCH');
        const previous = this.ledger.getSnapshot().find(record => record.context.operationId === operationId);
        if (previous) {
            if (!this.owns(previous) || canonicalJson(previous.input) !== canonicalJson(frozen)) throw failure('CALL_CONTROL_IDENTITY_MISMATCH');
            return this.reconcile(operationId);
        }
        try {
            await this.ledger.register({context: {operationId, viewId: 'independent-call-control'}, conversationId: this.sessionId,
                kind: 'command', status: 'submitting', input: frozen as unknown as OperationRecord['input']});
        } catch {
            log.warn('call.control', {operationId, stage: 'register', result: 'failure', code: 'CALL_CONTROL_SAVE_FAILED', durationMs: Date.now() - started});
            throw failure('CALL_CONTROL_SAVE_FAILED');
        }
        if (!current()) {
            const receipt: OperationReceipt = {operationId, status: 'rejected', code: 'CALL_VIEW_CLOSED', message: 'Control was not sent before the view closed'};
            await this.ledger.settle(receipt); return receipt;
        }
        return this.observe(frozen, true);
    }
    async reconcile(operationId: string): Promise<OperationReceipt> {
        const record = this.ledger.getSnapshot().find(value => value.context.operationId === operationId);
        if (!record || !this.owns(record)) throw failure('CALL_CONTROL_RECORD_MISSING');
        if (record.status === 'accepted') return {operationId, status: 'accepted'};
        if (record.status === 'rejected') return {operationId, status: 'rejected', code: 'CALL_CONTROL_REJECTED', message: record.message ?? 'Control was rejected'};
        return this.observe(record.input as unknown as Frozen, false);
    }
    private async observe(frozen: Frozen, write: boolean): Promise<OperationReceipt> {
        const {request} = frozen, remaining = frozen.protocol === callTreeCancellationProtocol;
        const started = Date.now(), operationId = request.requestId;
        let stage = write ? 'dispatch' : 'receipt';
        const action = remaining ? 'cancel-remaining' : 'interactionId' in request ? 'respond' : 'action' in request ? request.action : 'cancel';
        try {
            const {expectedEpoch: _epoch, value: _value, ...query} = request as Request & {expectedEpoch?: number; value?: unknown};
            const command = controlCommands[frozen.protocol][write ? 0 : 1];
            const result = await this.commands.execute<Result>(command, write ? request : query);
            stage = 'validate-receipt'; assertResult(request, result, query, remaining);
            if (this.ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status === 'accepted') return {operationId, status: 'accepted'};
            const receipt: OperationReceipt = result.receipt ? {operationId, status: 'accepted'}
                : {operationId, status: 'unknown', message: 'No retained control admission; query the original request'};
            stage = 'save-receipt';
            if (this.ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status !== receipt.status)
                await this.ledger.settle(receipt);
            log.info('call.control', {operationId, action, stage, result: receipt.status, durationMs: Date.now() - started}); return receipt;
        } catch (error) {
            log.warn('call.control', {operationId, action, stage, result: 'failure', code: safeCode(error), durationMs: Date.now() - started});
            if (this.ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status === 'accepted') return {operationId, status: 'accepted'};
            if (write) await this.ledger.settle({operationId, status: 'unknown', message: 'Query the original control receipt'});
            throw error;
        }
    }
    private owns(record: OperationRecord): boolean {
        const input = record.input as unknown as Partial<Frozen> | null, request = input?.request;
        return record.kind === 'command' && record.conversationId === this.sessionId && !!input?.protocol && Object.hasOwn(controlCommands, input.protocol)
            && request?.sessionId === this.sessionId && request.requestId === record.context.operationId;
    }
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
export function callControlErrorCode(error: unknown): string {return safeCode(error);}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_CONTROL_FAILED';
}

function assertResult(request: Request, result: Result,
    query: Omit<Request, 'expectedEpoch'>, remaining = false): void {
    if (!result || Object.entries(query).some(([key, value]) => result[key as keyof typeof query] !== value)) throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
    const receipt = result.receipt;
    if (!receipt) return;
    if ('interactionId' in request) {
        if (!('interactionId' in receipt) || receipt.requestId !== request.requestId || receipt.interactionId !== request.interactionId || receipt.taskId !== request.targetTaskId)
            throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
        return;
    }
    const valid = remaining ? 'rootStatus' in receipt && receipt.taskId === request.taskId
        && ['succeeded', 'failed', 'cancelled'].includes(receipt.rootStatus)
        && [receipt.controlEpoch, receipt.taskCount - 1].every(value => Number.isSafeInteger(value) && value >= 0) && Number.isFinite(receipt.acceptedAt)
        : 'action' in request
        ? 'action' in receipt && receipt.action === (request.action === 'resume' ? 'run' : request.action === 'withdraw' ? 'withdraw-pause' : 'pause')
            && receipt.accepted.requestId === request.requestId
        : 'status' in receipt && receipt.taskId === (request.targetTaskId ?? request.taskId) && ['succeeded', 'failed', 'cancelled'].includes(receipt.status);
    if (!valid || receipt.requestId !== request.requestId || !('expectedEpoch' in receipt) || receipt.expectedEpoch !== request.expectedEpoch) throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
}

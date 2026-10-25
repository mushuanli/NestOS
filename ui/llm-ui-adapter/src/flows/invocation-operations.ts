import {createModuleLogger} from '@itookit/common';
import type {OperationLedger, OperationReceipt, OperationRecord} from '@itookit/llm-ui';
import {FlowInvocationCommand, type FlowInvocationInput, type FlowInvocationRecord, type ICommandBus} from '@itookit/llm-session/contracts';
import {canonicalJson} from '../utils/canonical-json';

const log = createModuleLogger('flow-invocation-submission');
interface FrozenInvocation {protocol: 'flow-invocation-v1'; request: FlowInvocationInput}
/** UI intent is durable before dispatch; only the original host execution proves admission. */
export class InvocationOperations {
    constructor(private ledger: OperationLedger, private commands: ICommandBus, private sessionId: string) {}
    has(id: string): boolean {return this.ledger.getSnapshot().some(record => record.context.operationId === id && this.owns(record));}
    pending(): readonly OperationRecord[] {
        return this.ledger.getSnapshot().filter(record => this.owns(record) && ['unknown', 'submitting'].includes(record.status));
    }
    submit(input: FlowInvocationInput, signal?: AbortSignal): Promise<FlowInvocationRecord | undefined> {
        return trace(input.requestId, 'submit', () => this.dispatch(input, signal));
    }
    private async dispatch(input: FlowInvocationInput, signal?: AbortSignal): Promise<FlowInvocationRecord | undefined> {
        const request = JSON.parse(JSON.stringify(input)) as FlowInvocationInput, operationId = request.requestId;
        if (request.sessionId !== this.sessionId) throw new Error('Flow submission Session mismatch');
        const previous = this.ledger.getSnapshot().find(record => record.context.operationId === operationId);
        if (previous) {
            if (!this.owns(previous) || canonicalJson((previous.input as unknown as FrozenInvocation).request) !== canonicalJson(request))
                throw new Error('Flow submission identity mismatch');
            const found = await this.read(request);
            if (found || previous.status === 'accepted') return found;
            if (previous.status === 'rejected') throw new Error('Flow submission was rejected');
        } else await this.ledger.register({context: {operationId, viewId: 'flow-invocation'}, conversationId: this.sessionId,
            kind: 'command', input: {protocol: 'flow-invocation-v1', request} as unknown as OperationRecord['input'], status: 'submitting'});
        if (this.ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status === 'accepted') return this.read(request);
        try {
            signal?.throwIfAborted();
            const result = await this.commands.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, request);
            this.assertReceipt(request, result);
            await this.ledger.settle({operationId, status: 'accepted'}); return result;
        } catch (error) {
            await this.ledger.settle({operationId, status: 'unknown', message: 'Check the original Flow invocation before retrying'});
            throw error;
        }
    }
    reconcile(operationId: string): Promise<OperationReceipt> {
        return trace(operationId, 'reconcile', () => this.inspect(operationId));
    }
    private async inspect(operationId: string): Promise<OperationReceipt> {
        const record = this.ledger.getSnapshot().find(row => row.context.operationId === operationId);
        if (!record || !this.owns(record)) throw new Error('Flow submission is unavailable');
        const found = await this.read((record.input as unknown as FrozenInvocation).request);
        const receipt: OperationReceipt = found ? {operationId, status: 'accepted'}
            : {operationId, status: 'unknown', message: 'No admitted execution is visible; no command was sent'};
        await this.ledger.settle(receipt); return receipt;
    }
    private async read(request: FlowInvocationInput): Promise<FlowInvocationRecord | undefined> {
        const records = await this.commands.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, {sessionId: request.sessionId});
        const found = records.find(record => record.requestId === request.requestId);
        if (!found) return;
        this.assertRequest(request, found);
        if (!found.rootTaskId) return;
        this.assertReceipt(request, found);
        await this.ledger.settle({operationId: request.requestId, status: 'accepted'}); return found;
    }
    private assertReceipt(request: FlowInvocationInput, record: FlowInvocationRecord): void {
        this.assertRequest(request, record);
        if (typeof record.rootTaskId !== 'string' || !record.rootTaskId
            || request.execution === 'child' && (typeof record.executionSessionId !== 'string' || !record.executionSessionId || record.executionSessionId === request.sessionId))
            throw new Error('Flow execution admission is not confirmed');
    }
    private assertRequest(request: FlowInvocationInput, record?: FlowInvocationRecord): void {
        const projected = record && Object.fromEntries(Object.keys(request).map(key => [key, record[key as keyof FlowInvocationRecord]]));
        if (!projected || canonicalJson(projected) !== canonicalJson(request)) throw new Error('Flow invocation receipt does not match the frozen request');
    }
    private owns(record: OperationRecord): boolean {
        const input = record.input as unknown as Partial<FrozenInvocation> | null;
        return record.kind === 'command' && record.conversationId === this.sessionId && input?.protocol === 'flow-invocation-v1'
            && input.request?.sessionId === this.sessionId && input.request.requestId === record.context.operationId;
    }
}

async function trace<T>(id: string, stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const report = (outcome: string, error?: unknown) => {
        const code = (error as {code?: unknown})?.code;
        const data = {operation: 'flow.invocation', operationId: /^[\w-]{1,128}$/.test(id) ? id : undefined, stage, outcome,
            durationMs: Date.now() - started, ...(error ? {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_INVOCATION_FAILED'} : {})};
        try {if (error) log.warn('Flow invocation submission', data); else log.info('Flow invocation submission', data);} catch { /* Diagnostics cannot alter admission. */ }
    };
    try {
        const value = await work(), receipt = value as {status?: string; rootTaskId?: string} | undefined;
        report(receipt?.status ?? (receipt?.rootTaskId ? 'accepted' : 'unconfirmed')); return value;
    } catch (error) {report('failure', error); throw error;}
}

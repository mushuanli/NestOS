import {sha256HexSync} from '@itookit/common';
import type {OperationLedger, OperationRecord, OperationReceipt} from '@itookit/llm-ui';
import type {TaskControlReceipt} from '@itookit/durable-kernel/contracts';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';

export interface ControlInput {executionSessionId?: string; protocol: 'flow-control-v1'; taskId: string; action: 'pause' | 'resume' | 'withdraw'; expectedEpoch: number}

/** The existing UI ledger owns pending requests; Kernel receipts own admission facts. */
export class ControlOperations {
    constructor(private ledger: OperationLedger, private commands: ICommandBus, private sessionId: string) {}
    has(operationId: string): boolean {return this.ledger.getSnapshot().some(record => record.context.operationId === operationId && this.owns(record));}
    pending(taskId: string, executionSessionId = this.sessionId): readonly OperationRecord[] {
        return this.ledger.getSnapshot().filter(record => this.owns(record) && (record.input as unknown as ControlInput).taskId === taskId
            && ((record.input as unknown as ControlInput).executionSessionId ?? this.sessionId) === executionSessionId
            && ['submitting', 'unknown'].includes(record.status));
    }
    async run<T>(input: ControlInput, dispatch: (requestId: string) => Promise<T>): Promise<T | undefined> {
        input = normalizeControlScope(input, this.sessionId);
        const target = input.executionSessionId ?? this.sessionId;
        const operationId = `flow-control:${sha256HexSync(JSON.stringify([target, input.taskId, input.action, input.expectedEpoch]))}`;
        let record = this.ledger.getSnapshot().find(row => row.context.operationId === operationId);
        if (!record) {
            await this.ledger.register({context: {operationId, viewId: 'flow-control'}, conversationId: this.sessionId,
                kind: 'command', input: {...input}, status: 'submitting'});
            record = this.ledger.getSnapshot().find(row => row.context.operationId === operationId);
        }
        if (record && (!this.owns(record) || ((record.input as unknown as ControlInput).executionSessionId ?? this.sessionId) !== target
            || (record.input as unknown as ControlInput).taskId !== input.taskId
            || (record.input as unknown as ControlInput).action !== input.action || (record.input as unknown as ControlInput).expectedEpoch !== input.expectedEpoch))
            throw new Error('Flow control identity mismatch');
        if (record?.status === 'accepted') return;
        if (!record || record.status === 'rejected') throw new Error('Flow control request is unavailable');
        try {
            const result = await dispatch(operationId);
            await this.ledger.settle(result === false
                ? {operationId, status: 'unknown', message: 'Control was not sent before the view closed'}
                : {operationId, status: 'accepted'});
            return result;
        } catch (error) {
            await this.ledger.settle({operationId, status: 'unknown', message: 'Query the original control receipt'});
            throw error;
        }
    }
    async reconcile(operationId: string): Promise<OperationReceipt> {
        const record = this.ledger.getSnapshot().find(row => row.context.operationId === operationId);
        if (!record || !this.owns(record)) throw new Error('Flow control request is unavailable');
        const input = record.input as unknown as ControlInput;
        const receipt = await this.commands.execute<TaskControlReceipt | undefined>(FlowCommand.RunControlReceipt,
            {sessionId: input.executionSessionId ?? this.sessionId, taskId: input.taskId, requestId: operationId});
        const action = input.action === 'resume' ? 'run' : input.action === 'withdraw' ? 'withdraw-pause' : 'pause';
        if (receipt && (receipt.requestId !== operationId || receipt.accepted.requestId !== operationId
            || receipt.action !== action || receipt.expectedEpoch !== input.expectedEpoch)) throw new Error('Control receipt identity mismatch');
        const result: OperationReceipt = receipt ? {operationId, status: 'accepted'}
            : {operationId, status: 'unknown', message: 'No retained control receipt; no command was sent'};
        await this.ledger.settle(result); return result;
    }
    private owns(record: OperationRecord): boolean {
        const input = record.input as unknown as Partial<ControlInput> | null;
        return record.kind === 'command' && record.conversationId === this.sessionId && input?.protocol === 'flow-control-v1'
            && typeof input.taskId === 'string' && !!input.taskId && ['pause', 'resume', 'withdraw'].includes(input.action ?? '')
            && (input.executionSessionId === undefined || typeof input.executionSessionId === 'string' && !!input.executionSessionId)
            && Number.isSafeInteger(input.expectedEpoch) && input.expectedEpoch! >= 0;
    }
}

function normalizeControlScope(input: ControlInput, owner: string): ControlInput {
    if (input.executionSessionId !== undefined && (typeof input.executionSessionId !== 'string' || !input.executionSessionId))
        throw new Error('Flow control execution Session is invalid');
    const {executionSessionId, ...local} = input;
    return executionSessionId && executionSessionId !== owner ? {...local, executionSessionId} : local;
}

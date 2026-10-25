import type {Kernel, TaskRecord, TaskCancellationReceipt, TaskControlReceipt} from '@itookit/durable-kernel';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {IndependentCallCommand, type IndependentCallCancelRequest, type IndependentCallControlQuery, type IndependentCallCancellationReceipt, type IndependentCallStateControlQuery, type IndependentCallStateControlRequest, type IndependentCallStateControlReceipt} from '../contracts/independent-calls';
import type {ICommandBus} from '../contracts/command-bus';
import type {SessionLogger} from '../utils/host-ports';

interface Options {
    kernel: Kernel; commands: ICommandBus; logger: SessionLogger;
    resolve(query: IndependentCallControlQuery): Promise<TaskRecord>;
    canWrite?(sessionId: string): Promise<boolean>;
}

/** Session owns call membership; Flow and Kernel keep execution and cancellation authority. */
export class IndependentCallControls {
    constructor(private readonly options: Options) {}
    register(): void {
        this.options.commands.register(IndependentCallCommand.Cancel, value => this.perform(value as IndependentCallCancelRequest, true));
        this.options.commands.register(IndependentCallCommand.CancellationReceipt, value => this.perform(value as IndependentCallControlQuery, false));
        this.options.commands.register(IndependentCallCommand.Control, value => this.perform(value as IndependentCallStateControlRequest, true, true));
        this.options.commands.register(IndependentCallCommand.ControlReceipt, value => this.perform(value as IndependentCallStateControlQuery, false, true));
    }
    private async perform(supplied: IndependentCallControlQuery, write: boolean, state = false): Promise<IndependentCallCancellationReceipt | IndependentCallStateControlReceipt> {
        const started = Date.now(); let stage = 'validate', outcome = 'failure', code: string | undefined;
        let input: IndependentCallControlQuery | undefined;
        try {
            input = structuredClone(supplied); validate(input, write, state); stage = 'ownership';
            const task = await this.options.resolve(input);
            if (write) {stage = 'authorization'; await this.writable(input.sessionId); await this.writable(input.executionSessionId);}
            stage = write ? state ? 'control' : 'cancel' : 'receipt';
            if (state) {
                const request = input as IndependentCallStateControlQuery, receipt = await this.executeState(request, task, write);
                assertStateReceipt(request, receipt, write); outcome = receipt ? 'observed' : 'missing';
                return {...scope(input), action: request.action, ...(receipt ? {receipt} : {})};
            }
            const receipt = await this.execute(input, task, write); assertReceipt(input, receipt, write); outcome = receipt?.status ?? 'missing';
            return {...scope(input), ...(receipt ? {receipt} : {})};
        } catch (error) {code = safeCode(error); throw error;}
        finally {
            const metadata = {operation: state ? write ? 'call.control' : 'call.control.receipt' : write ? 'call.cancel' : 'call.cancel.receipt',
                action: state ? safeAction((input as IndependentCallStateControlQuery)?.action) : 'cancel', operationId: safeId(input?.requestId),
                callId: safeId(input?.callId), sessionId: safeId(input?.sessionId), taskId: safeId(input?.taskId),
                stage, outcome, code, durationMs: Date.now() - started};
            this.log(metadata, outcome === 'failure');
        }
    }
    private async execute(input: IndependentCallControlQuery, task: TaskRecord, write: boolean): Promise<TaskCancellationReceipt | undefined> {
        const query = {sessionId: input.executionSessionId, taskId: input.taskId, requestId: input.requestId};
        if (task.program.kind === 'flow.aggregate' || task.labels?.kind === 'flow-root') {
            if (write) await this.options.commands.execute(FlowCommand.RunCancel, {...query, expectedEpoch: (input as IndependentCallCancelRequest).expectedEpoch});
            return this.options.commands.execute(FlowCommand.RunCancellationReceipt, query);
        }
        if (write) await this.options.kernel.cancel(query.sessionId, query.taskId, 'Cancelled from independent call',
            {requestId: query.requestId, expectedEpoch: (input as IndependentCallCancelRequest).expectedEpoch});
        return this.options.kernel.readTaskCancellationReceipt(query.sessionId, query.taskId, query.requestId);
    }
    private async executeState(input: IndependentCallStateControlQuery, task: TaskRecord, write: boolean): Promise<TaskControlReceipt | undefined> {
        const query = {sessionId: input.executionSessionId, taskId: input.taskId, requestId: input.requestId};
        if (task.program.kind === 'flow.aggregate' || task.labels?.kind === 'flow-root') {
            if (write) {
                await this.options.commands.execute(FlowCommand.RunGet, {sessionId: query.sessionId, taskId: query.taskId});
                const control = {taskId: query.taskId, requestId: query.requestId, expectedEpoch: (input as IndependentCallStateControlRequest).expectedEpoch};
                if (input.action === 'withdraw') await this.options.commands.execute(FlowCommand.RunPauseWithdraw, control);
                else await this.options.commands.execute(FlowCommand.RunGoalUpdate, {...control, goal: {status: input.action === 'pause' ? 'paused' : 'active'}});
            }
            return this.options.commands.execute(FlowCommand.RunControlReceipt, query);
        }
        if (write) {
            const options = {requestId: query.requestId, expectedEpoch: (input as IndependentCallStateControlRequest).expectedEpoch};
            if (input.action === 'withdraw') await this.options.kernel.withdrawTaskPause(query.sessionId, query.taskId, options);
            else await this.options.kernel.controlTask(query.sessionId, query.taskId, input.action === 'pause' ? 'pause' : 'run', options);
        }
        return this.options.kernel.readTaskControlReceipt(query.sessionId, query.taskId, query.requestId);
    }
    private log(metadata: Record<string, unknown>, failed: boolean): void {
        try {
            if (failed) this.options.logger.warn('Independent call control failed', metadata);
            else this.options.logger.info('Independent call control observed', metadata);
        } catch { /* Diagnostics must not replace a durable control outcome. */ }
    }
    private async writable(id: string): Promise<void> {
        if (this.options.canWrite && !await this.options.canWrite(id)) throw failure('CALL_READ_ONLY');
    }
}
function scope(input: IndependentCallControlQuery): IndependentCallControlQuery {
    const {sessionId, branchId, callId, executionSessionId, taskId, requestId} = input;
    return {sessionId, branchId, callId, executionSessionId, taskId, requestId};
}
function validate(input: IndependentCallControlQuery, write: boolean, state: boolean): void {
    const keys = ['sessionId', 'branchId', 'callId', 'executionSessionId', 'taskId', 'requestId', ...(state ? ['action'] : [])];
    const epoch = (input as IndependentCallCancelRequest)?.expectedEpoch;
    if (!input || keys.some(key => typeof input[key as keyof IndependentCallControlQuery] !== 'string'
        || !input[key as keyof IndependentCallControlQuery].trim())
        || Object.keys(input).some(key => !keys.includes(key) && !(write && key === 'expectedEpoch'))
        || state && !safeAction((input as IndependentCallStateControlQuery).action)
        || write && (!Number.isSafeInteger(epoch) || epoch < 0)) throw failure('CALL_CONTROL_INVALID');
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function safeId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_CONTROL_FAILED';
}

function assertReceipt(input: IndependentCallControlQuery, receipt: TaskCancellationReceipt | undefined, write: boolean): void {
    if (receipt && (receipt.requestId !== input.requestId || receipt.taskId !== input.taskId
        || !['succeeded', 'failed', 'cancelled'].includes(receipt.status)
        || write && receipt.expectedEpoch !== (input as IndependentCallCancelRequest).expectedEpoch))
        throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
}

function safeAction(value: unknown): 'pause' | 'resume' | 'withdraw' | undefined {
    return value === 'pause' || value === 'resume' || value === 'withdraw' ? value : undefined;
}
function assertStateReceipt(input: IndependentCallStateControlQuery, receipt: TaskControlReceipt | undefined, write: boolean): void {
    const action = input.action === 'resume' ? 'run' : input.action === 'withdraw' ? 'withdraw-pause' : 'pause';
    if (receipt && (receipt.requestId !== input.requestId || receipt.accepted.requestId !== input.requestId || receipt.action !== action
        || write && receipt.expectedEpoch !== (input as IndependentCallStateControlRequest).expectedEpoch))
        throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
}

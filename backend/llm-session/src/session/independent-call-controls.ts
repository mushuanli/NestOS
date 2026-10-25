import {readCallMember} from './independent-call-membership';
import type {Kernel, TaskRecord, TaskCancellationReceipt, TaskControlReceipt, TaskTreeCancellationReceipt} from '@itookit/durable-kernel';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {IndependentCallCommand, type IndependentCallTreeCancellationReceipt, type IndependentCallCancelRequest, type IndependentCallCancellationQuery, type IndependentCallControlQuery, type IndependentCallCancellationReceipt, type IndependentCallStateControlQuery, type IndependentCallStateControlRequest, type IndependentCallStateControlReceipt} from '../contracts/independent-calls';
import type {ICommandBus} from '../contracts/command-bus';
import type {SessionLogger} from '../utils/host-ports';

interface Options {
    kernel: Kernel; commands: ICommandBus; logger: SessionLogger;
    resolve(query: IndependentCallControlQuery): Promise<TaskRecord>;
    canWrite?(sessionId: string): Promise<boolean>;
}

const CONTROL_OPERATIONS = {cancel: 'cancel', state: 'control', remaining: 'cancel-remaining'} as const;
type ControlKind = keyof typeof CONTROL_OPERATIONS;
type ControlResult = IndependentCallCancellationReceipt | IndependentCallStateControlReceipt | IndependentCallTreeCancellationReceipt;

/** Session owns call membership; Flow and Kernel keep execution and cancellation authority. */
export class IndependentCallControls {
    constructor(private readonly options: Options) {}
    register(): void {
        this.options.commands.register(IndependentCallCommand.Cancel, value => this.perform(value as IndependentCallCancelRequest, true));
        this.options.commands.register(IndependentCallCommand.CancellationReceipt, value => this.perform(value as IndependentCallCancellationQuery, false));
        this.options.commands.register(IndependentCallCommand.Control, value => this.perform(value as IndependentCallStateControlRequest, true, 'state'));
        this.options.commands.register(IndependentCallCommand.ControlReceipt, value => this.perform(value as IndependentCallStateControlQuery, false, 'state'));
        this.options.commands.register(IndependentCallCommand.CancelRemaining, value => this.perform(value as IndependentCallControlQuery, true, 'remaining'));
        this.options.commands.register(IndependentCallCommand.TreeCancellationReceipt, value => this.perform(value as IndependentCallControlQuery, false, 'remaining'));
    }
    private async perform(supplied: IndependentCallCancellationQuery, write: boolean, kind: ControlKind = 'cancel'): Promise<ControlResult> {
        const started = Date.now(), operation = CONTROL_OPERATIONS[kind]; let stage = 'validate', outcome = 'failure', code: string | undefined;
        let input: IndependentCallCancellationQuery | undefined;
        try {
            input = structuredClone(supplied); validate(input, write, kind); stage = 'ownership';
            const task = await this.resolveTarget(input);
            if (write) {stage = 'authorization'; await this.writable(input.sessionId); await this.writable(input.executionSessionId);}
            stage = write ? operation : 'receipt';
            const result = await this.dispatch(input, task, write, kind), receipt = result.receipt;
            outcome = receipt ? 'status' in receipt ? receipt.status : 'observed' : 'missing';
            return result;
        } catch (error) {code = safeCode(error); throw error;}
        finally {
            const metadata = {operation: `call.${operation}${write ? '' : '.receipt'}`,
                action: kind === 'state' ? safeAction((input as IndependentCallStateControlQuery)?.action) : operation, operationId: safeId(input?.requestId),
                callId: safeId(input?.callId), sessionId: safeId(input?.sessionId), taskId: safeId(input?.taskId), targetTaskId: safeId(input?.targetTaskId),
                stage, outcome, code, durationMs: Date.now() - started};
            this.log(metadata, outcome === 'failure');
        }
    }
    private async dispatch(input: IndependentCallCancellationQuery, task: TaskRecord, write: boolean, kind: ControlKind): Promise<ControlResult> {
        if (kind === 'state') {
            const request = input as IndependentCallStateControlQuery, receipt = await this.executeState(request, task, write);
            assertStateReceipt(request, receipt, write);
            return {...scope(input), action: request.action, ...(receipt ? {receipt} : {})};
        }
        if (kind === 'remaining') {
            const receipt = await this.executeRemaining(input, task, write);
            assertTreeReceipt(input, receipt, write);
            return {...scope(input), ...(receipt ? {receipt} : {})};
        }
        const receipt = await this.execute(input, task, write); assertReceipt(input, receipt, write);
        return {...scope(input), ...(receipt ? {receipt} : {})};
    }
    private async executeRemaining(input: IndependentCallControlQuery, task: TaskRecord, write: boolean): Promise<TaskTreeCancellationReceipt | undefined> {
        const query = {sessionId: input.executionSessionId, taskId: input.taskId, requestId: input.requestId};
        if (task.program.kind === 'flow.aggregate' || task.labels?.kind === 'flow-root') {
            if (write) await this.options.commands.execute(FlowCommand.RunCancelRemaining, {...query, expectedEpoch: (input as IndependentCallCancelRequest).expectedEpoch});
            return this.options.commands.execute(FlowCommand.RunTreeCancellationReceipt, query);
        }
        if (write) await this.options.kernel.cancelRemainingTaskTree(query.sessionId, query.taskId,
            {requestId: query.requestId, expectedEpoch: (input as IndependentCallCancelRequest).expectedEpoch});
        return this.options.kernel.readTaskTreeCancellationReceipt(query.sessionId, query.taskId, query.requestId);
    }
    private async resolveTarget(input: IndependentCallCancellationQuery): Promise<TaskRecord> {
        const root = await this.options.resolve(input);
        return input.targetTaskId ? readCallMember(this.options.kernel, root, input.targetTaskId,
            {tree: 'CALL_CONTROL_TREE_INVALID', scope: 'CALL_CONTROL_SCOPE_MISMATCH'}) : root;
    }
    private async execute(input: IndependentCallCancellationQuery, task: TaskRecord, write: boolean): Promise<TaskCancellationReceipt | undefined> {
        const query = {sessionId: input.executionSessionId, taskId: input.targetTaskId ?? input.taskId, requestId: input.requestId};
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
function scope(input: IndependentCallCancellationQuery): IndependentCallCancellationQuery {
    const {sessionId, branchId, callId, executionSessionId, taskId, requestId} = input;
    return {sessionId, branchId, callId, executionSessionId, taskId, requestId, ...(input.targetTaskId ? {targetTaskId: input.targetTaskId} : {})};
}
function validate(input: IndependentCallCancellationQuery, write: boolean, kind: ControlKind): void {
    const state = kind === 'state';
    const keys = ['sessionId', 'branchId', 'callId', 'executionSessionId', 'taskId', 'requestId', ...(state ? ['action'] : [])];
    if (kind === 'cancel' && input && Object.hasOwn(input, 'targetTaskId')) keys.push('targetTaskId');
    if (!validIdentity(input, keys, write)) throw failure('CALL_CONTROL_INVALID');
    if (state && !safeAction((input as IndependentCallStateControlQuery).action)) throw failure('CALL_CONTROL_INVALID');
    const epoch = (input as IndependentCallCancelRequest).expectedEpoch;
    if (write && (!Number.isSafeInteger(epoch) || epoch < 0)) throw failure('CALL_CONTROL_INVALID');
}
function validIdentity(input: IndependentCallCancellationQuery, keys: string[], write: boolean): boolean {
    if (!input || typeof input !== 'object') return false;
    const values = input as unknown as Record<string, unknown>;
    return keys.every(key => typeof values[key] === 'string' && !!values[key].trim())
        && Object.keys(input).every(key => keys.includes(key) || write && key === 'expectedEpoch');
}

function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function safeId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_CONTROL_FAILED';
}

function assertReceipt(input: IndependentCallCancellationQuery, receipt: TaskCancellationReceipt | undefined, write: boolean): void {
    if (receipt && (receipt.requestId !== input.requestId || receipt.taskId !== (input.targetTaskId ?? input.taskId)
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

function assertTreeReceipt(input: IndependentCallControlQuery, receipt: TaskTreeCancellationReceipt | undefined, write: boolean): void {
    if (write && !receipt) throw failure('CALL_CONTROL_RECEIPT_MISSING');
    if (receipt && (receipt.requestId !== input.requestId || receipt.taskId !== input.taskId
        || !['succeeded', 'failed', 'cancelled'].includes(receipt.rootStatus)
        || [receipt.controlEpoch, receipt.expectedEpoch, receipt.taskCount - 1].some(value => !Number.isSafeInteger(value) || value < 0)
        || !Number.isFinite(receipt.acceptedAt)
        || write && receipt.expectedEpoch !== (input as IndependentCallCancelRequest).expectedEpoch))
        throw failure('CALL_CONTROL_RECEIPT_MISMATCH');
}

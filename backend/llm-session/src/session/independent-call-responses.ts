import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {IndependentCallCommand, type IndependentCallControlQuery, type IndependentCallResponseQuery,
    type IndependentCallResponseRequest, type IndependentCallResponseReceipt, type IndependentCallInteractionDetail} from '../contracts/independent-calls';
import type {ICommandBus} from '../contracts/command-bus';
import type {SessionLogger} from '../utils/host-ports';
import {readIndependentCallInteractionTask} from './independent-call-interactions';

interface Options {
    kernel: Kernel; commands: ICommandBus; logger: SessionLogger;
    resolve(query: IndependentCallControlQuery): Promise<TaskRecord>;
    canWrite?(sessionId: string): Promise<boolean>;
}
/** Session authorizes call membership; Kernel owns the atomic answer and original receipt. */
export class IndependentCallResponses {
    constructor(private options: Options) {}
    register(): void {
        this.options.commands.register(IndependentCallCommand.Respond, value => this.perform(value as IndependentCallResponseRequest, 'respond'));
        this.options.commands.register(IndependentCallCommand.ResponseReceipt, value => this.perform(value as IndependentCallResponseQuery, 'receipt'));
        this.options.commands.register(IndependentCallCommand.Interaction, value => this.perform(value as IndependentCallResponseQuery, 'detail'));
    }
    private async perform(supplied: IndependentCallResponseQuery, mode: 'respond' | 'receipt' | 'detail'): Promise<IndependentCallResponseReceipt | IndependentCallInteractionDetail> {
        const write = mode === 'respond';
        const started = Date.now(); let stage = 'validate', outcome = 'failure', code: string | undefined;
        let input: IndependentCallResponseQuery | undefined;
        try {
            input = structuredClone(supplied); validate(input, write); stage = 'ownership';
            const root = await this.options.resolve(input);
            const target = await readIndependentCallInteractionTask(this.options.kernel, root, input.targetTaskId);
            if (!target.interactions[input.interactionId]) throw failure('CALL_INTERACTION_NOT_FOUND');
            if (mode === 'detail') {stage = 'detail'; const result = detail(input, target); outcome = 'observed'; return result;}
            if (write) {
                stage = 'authorization'; await this.writable(input.sessionId); await this.writable(input.executionSessionId);
                stage = 'respond'; await this.respond(input as IndependentCallResponseRequest, root);
            }
            stage = 'receipt';
            const receipt = await this.options.kernel.readTaskInteractionResponseReceipt(input.executionSessionId, input.targetTaskId, input.requestId);
            if (receipt && (receipt.requestId !== input.requestId || receipt.taskId !== input.targetTaskId || receipt.interactionId !== input.interactionId))
                throw failure('CALL_RESPONSE_RECEIPT_MISMATCH');
            outcome = receipt ? 'observed' : 'missing'; return {...scope(input), ...(receipt ? {receipt} : {})};
        } catch (error) {code = safeCode(error); throw error;}
        finally {this.log(input, {stage, outcome, code, durationMs: Date.now() - started}, mode);}
    }
    private async respond(input: IndependentCallResponseRequest, root: TaskRecord): Promise<void> {
        if (root.program.kind === 'flow.aggregate' || root.labels?.kind === 'flow-root') {
            await this.options.commands.execute(FlowCommand.RunGet, {sessionId: input.executionSessionId, taskId: input.taskId});
            await this.options.commands.execute(FlowCommand.RunRespond, {taskId: input.taskId, targetTaskId: input.targetTaskId,
                requestId: input.interactionId, responseRequestId: input.requestId, value: input.value});
        } else await this.options.kernel.respondInteraction(input.executionSessionId, input.targetTaskId,
            {interactionId: input.interactionId, value: input.value}, {requestId: input.requestId});
    }
    private async writable(sessionId: string): Promise<void> {
        if (this.options.canWrite && !await this.options.canWrite(sessionId)) throw failure('CALL_READ_ONLY');
    }
    private log(input: IndependentCallResponseQuery | undefined, result: Record<string, unknown>, mode: 'respond' | 'receipt' | 'detail'): void {
        const safe = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;
        const detail = {operation: mode === 'respond' ? 'call.respond' : mode === 'detail' ? 'call.interaction' : 'call.response.receipt', operationId: safe(input?.requestId),
            callId: safe(input?.callId), taskId: safe(input?.targetTaskId), sessionId: safe(input?.sessionId), ...result};
        try {
            if (result.outcome === 'failure') this.options.logger.warn('Independent call response failed', detail);
            else this.options.logger.info('Independent call response observed', detail);
        } catch { /* Diagnostics cannot replace a durable response outcome. */ }
    }
}
function scope(input: IndependentCallResponseQuery): IndependentCallResponseQuery {
    const {sessionId, branchId, callId, executionSessionId, taskId, targetTaskId, interactionId, requestId} = input;
    return {sessionId, branchId, callId, executionSessionId, taskId, targetTaskId, interactionId, requestId};
}
function validate(input: IndependentCallResponseQuery, write: boolean): void {
    const keys = ['sessionId', 'branchId', 'callId', 'executionSessionId', 'taskId', 'targetTaskId', 'interactionId', 'requestId'];
    if (!input || keys.some(key => typeof input[key as keyof IndependentCallResponseQuery] !== 'string' || !input[key as keyof IndependentCallResponseQuery].trim())
        || Object.keys(input).some(key => !keys.includes(key) && !(write && key === 'value'))
        || input.requestId.length > 256 || write && !Object.hasOwn(input, 'value')) throw failure('CALL_RESPONSE_INVALID');
    if (write && !jsonInput((input as IndependentCallResponseRequest).value)) throw failure('CALL_RESPONSE_VALUE_INVALID');
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_RESPONSE_FAILED';
}

function jsonInput(value: unknown, seen = new Set<object>(), depth = 0): boolean {
    if (depth > 64) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const valid = Array.isArray(value)
        ? Object.keys(value).length === value.length && Array.from(value).every(item => jsonInput(item, seen, depth + 1))
        : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
            && Object.values(value).every(item => jsonInput(item, seen, depth + 1));
    seen.delete(value); return valid;
}

function detail(input: IndependentCallResponseQuery, target: TaskRecord): IndependentCallInteractionDetail {
    const {id, kind, prompt, payload, requestedAt, status} = target.interactions[input.interactionId];
    const interaction = {id, kind, prompt, ...(payload !== undefined ? {payload} : {}), requestedAt, status};
    if (new TextEncoder().encode(JSON.stringify(interaction)).byteLength > 1024 * 1024) throw failure('CALL_INTERACTION_DETAIL_TOO_LARGE');
    return {...scope(input), interaction};
}

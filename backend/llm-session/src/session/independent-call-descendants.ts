import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import {IndependentCallCommand, type IndependentCallDescendantsQuery, type IndependentCallDescendantsResult, type IndependentCallExecutionQuery} from '../contracts/independent-calls';
import type {ICommandBus} from '../contracts/command-bus';
import type {SessionLogger} from '../utils/host-ports';
import {readIndependentCallTree} from './independent-call-tree';

/** Page the existing execution facts without acquiring a writer or retaining another snapshot store. */
export class IndependentCallDescendants {
    constructor(private kernel: Kernel, private logger: SessionLogger, private resolve: (query: IndependentCallExecutionQuery) => Promise<TaskRecord>) {}
    register(commands: ICommandBus): void {commands.register(IndependentCallCommand.Descendants, input => this.read(input as IndependentCallDescendantsQuery));}
    async read(supplied: IndependentCallDescendantsQuery): Promise<IndependentCallDescendantsResult> {
        const started = Date.now(); let input: IndependentCallDescendantsQuery | undefined, stage = 'validate', code: string | undefined;
        try {
            input = structuredClone(supplied); validate(input); stage = 'ownership';
            const root = await this.resolve(input); stage = 'snapshot';
            const result = await readIndependentCallTree(this.kernel, root, input.afterTaskId);
            return {...input, asOfSequence: result.tree.asOfSequence, descendants: result.descendants};
        } catch (error) {
            const suppliedCode = (error as {code?: unknown})?.code;
            code = typeof suppliedCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(suppliedCode) ? suppliedCode : 'CALL_DESCENDANTS_READ_FAILED'; throw error;
        } finally {
            const safe = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;
            const metadata = {operation: 'call.descendants', operationId: safe(input?.callId), taskId: safe(input?.taskId), stage,
                result: code ? 'failure' : 'observed', code, durationMs: Date.now() - started};
            try {if (code) this.logger.warn('Independent descendants read failed', metadata); else this.logger.debug('Independent descendants read', metadata);}
            catch { /* Observation diagnostics must not change the result. */ }
        }
    }
}
function validate(input: IndependentCallDescendantsQuery): void {
    if (!input || typeof input !== 'object') throw invalid();
    const keys = ['sessionId', 'branchId', 'callId', 'executionSessionId', 'taskId'];
    if (Object.hasOwn(input, 'afterTaskId')) keys.push('afterTaskId');
    const values = input as unknown as Record<string, unknown>;
    if (keys.some(key => typeof values[key] !== 'string' || !values[key].trim() || values[key].length > 512)
        || Object.keys(input).some(key => !keys.includes(key))) throw invalid();
}
function invalid(): Error {return Object.assign(new Error('CALL_DESCENDANTS_QUERY_INVALID'), {code: 'CALL_DESCENDANTS_QUERY_INVALID'});}

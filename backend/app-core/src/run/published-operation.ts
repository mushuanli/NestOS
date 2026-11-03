import type {IndependentCallService} from '@itookit/llm-session';
import type {IndependentCallInput} from '@itookit/llm-session/contracts';
import type {Kernel, TaskCallResult} from '@itookit/durable-kernel';
import {nodeOutputEntries} from '@itookit/llm-flow/contracts';
import {requireValue} from '../kanban/validation';

export interface PublishedOperationOptions {
    calls: Pick<IndependentCallService, 'prepareTaskCall' | 'submitPreparedTaskCall' | 'inspectTaskCallSubmission' | 'list'>;
    kernel: Pick<Kernel, 'task'>; prepareSession(id: string): Promise<boolean>;
    ensureSession(id: string, title: string): Promise<unknown>;
}
export interface OperationObservation {state: 'running' | 'unknown' | 'succeeded' | 'failed'; sessionId?: string; output?: unknown; code?: string}
/** Published calls retain the same frozen identity across lost replies and host restarts. */
export function publishedOperation(options: PublishedOperationOptions) {
    return {async start(input: IndependentCallInput): Promise<OperationObservation> {
        const id = input.request.expectedSessionId!;
        try {
            await options.ensureSession(id, input.title);
            requireValue(await options.prepareSession(id), 'OPERATION_SESSION_OWNED');
            await options.calls.prepareTaskCall(input, {maxDepth: 4, timeoutMs: null});
        } catch (error) {throw Object.assign(error as Error, {executionOutcome: 'not-started', retryable: (error as {code?: string})?.code === 'OPERATION_SESSION_OWNED'});}
        await options.calls.submitPreparedTaskCall(input); return inspect(options, input);
    }, inspect: (input: IndependentCallInput) => inspect(options, input)};
}
async function inspect(options: PublishedOperationOptions, input: IndependentCallInput): Promise<OperationObservation> {
    const admission = await options.calls.inspectTaskCallSubmission(input);
    if (!admission) return {state: 'unknown', code: 'OPERATION_ADMISSION_UNKNOWN'};
    const view = (await options.calls.list({sessionId: input.request.expectedSessionId!, branchId: input.request.expectedBranch}))
        .find(row => row.input.request.submission?.id === input.request.submission!.id);
    const sessionId = admission.executionSessionId;
    if (!view?.callerState?.settled || !view.executionTree?.settled) return {state: 'running', sessionId};
    const task = await options.kernel.task(admission.submission.task.sessionId, admission.submission.task.taskId);
    const result = task.exit?.output as TaskCallResult | undefined;
    if (task.exit?.status !== 'succeeded' || result?.exit.status !== 'succeeded') return {state: 'failed', sessionId, code: 'OPERATION_EXECUTION_FAILED'};
    const returned = (result.exit.output as {nodes?: Record<string, unknown>})?.nodes?.__flow_return;
    if (!returned) return {state: 'failed', sessionId, code: 'OPERATION_RESULT_MISSING'};
    const output = nodeOutputEntries(returned).find(entry => entry.name === 'result')?.value;
    try {return {state: 'succeeded', sessionId, output: typeof output === 'string' ? JSON.parse(output) : output};}
    catch {return {state: 'failed', sessionId, code: 'OPERATION_RESULT_INVALID'};}
}

import type {KanbanExecutionPort} from '@itookit/kanban/execution';
import type {KanbanDispatch, KanbanItem} from '@itookit/kanban/contracts';
import type {IndependentCallService} from '@itookit/llm-session';
import type {SubmissionRequest, IndependentCallInput} from '@itookit/llm-session/contracts';
import type {TargetRef} from '@itookit/llm-flow/contracts';
import type {Kernel} from '@itookit/durable-kernel';
import {readContextCatalog} from '../projects/harness-context-catalog';
import {requireValue} from './validation';
import type {sessionSubmission} from '../run/session-submission';

interface Origin {schema: 1; dispatch: KanbanDispatch; input: IndependentCallInput}
interface Continued {schema: 2; dispatch: KanbanDispatch; origin: Origin; request: SubmissionRequest}
export interface ContinueWorkOptions {
    submission: ReturnType<typeof sessionSubmission>; calls: Pick<IndependentCallService, 'inspectTaskCallSubmission' | 'list'>;
    kernel: Pick<Kernel, 'inspectSession' | 'sessionActivity'>;
    prepare?(input: {dispatch: KanbanDispatch; item: KanbanItem; originalDispatch: KanbanDispatch; sessionId: string; target: TargetRef}): Promise<string>;
    observe?(dispatch: KanbanDispatch, result: import('@itookit/kanban/execution').KanbanExecutionObservation): Promise<import('@itookit/kanban/execution').KanbanExecutionObservation>;
}
/** The predecessor remains terminal; a new request runs in its original execution Session. */
export function withContinuedWork(executor: KanbanExecutionPort, options: ContinueWorkOptions): KanbanExecutionPort {
    const observe = async (value: Continued, start: boolean) => {
        const result = await options.submission[start ? 'start' : 'inspect'](value.request);
        const observation = {executionSessionId: result.sessionId, outcome: result.outcome, code: result.code, ...(result.outcome === 'succeeded' ? {outputs: []} : {})};
        return options.observe ? options.observe(value.dispatch, observation) : observation;
    };
    return {...executor, prepareContinuation: (dispatch, item, previous) => prepare(options, dispatch, item, previous),
        start: value => isContinued(value) ? observe(value, true) : executor.start(value),
        inspect: value => isContinued(value) ? observe(value, false) : executor.inspect(value)};
}
function isContinued(value: unknown): value is Continued {return (value as Continued)?.schema === 2;}
async function prepare(options: ContinueWorkOptions, dispatch: KanbanDispatch, item: KanbanItem, previous: unknown): Promise<Continued> {
    const origin = isContinued(previous) ? previous.origin : previous as Origin;
    requireValue(origin?.schema === 1 && origin.dispatch?.itemId === item.id && origin.input?.request?.expectedTarget, 'CONTINUATION_SCOPE_MISMATCH');
    const admission = await options.calls.inspectTaskCallSubmission(origin.input as Parameters<IndependentCallService['inspectTaskCallSubmission']>[0]);
    requireValue(admission?.executionSessionId, 'CONTINUATION_SESSION_UNKNOWN');
    const sessionId = admission.executionSessionId, original = origin.input.request;
    const calls = await options.calls.list({sessionId: original.expectedSessionId!});
    requireValue(calls.length && calls.every(call => call.callerState?.settled && call.executionTree?.settled), 'CONTINUATION_IN_USE');
    const activity = await options.kernel.sessionActivity(sessionId);
    requireValue(!Object.entries(activity.counts).some(([key, count]) => ['running', 'queued', 'created', 'waiting', 'blocked', 'paused'].includes(key) && count > 0), 'CONTINUATION_IN_USE');
    const catalog = await readContextCatalog(options.kernel, sessionId), branch = original.expectedBranch!;
    const bindings = Object.values(catalog.value.bindings).filter(binding => binding.branchId === branch);
    requireValue(bindings.length <= 1 && bindings.every(binding => binding.validity === 'valid' && !binding.activeOperation), 'CONTINUATION_CONTEXT_AMBIGUOUS');
    const binding = bindings[0], target = original.expectedTarget!;
    const instruction = await options.prepare?.({dispatch, item, originalDispatch: origin.dispatch, sessionId, target})
        ?? dispatch.continuation?.instruction;
    requireValue(instruction, 'CONTINUATION_INSTRUCTION_REQUIRED');
    const request: SubmissionRequest = {expectedSessionId: sessionId, expectedBranch: branch, expectedTarget: target,
        target: {kind: target.kind, id: target.id, version: target.version}, source: {kind: 'composer', text: instruction, attachments: [], values: {}},
        submission: {id: dispatch.id, source: {kind: 'conversation', ownerId: sessionId, id: dispatch.id}},
        overrides: {...original.overrides, baseRoundId: undefined, newBranchName: undefined, branchMode: 'continue',
            ...(binding ? {harnessConversation: {mode: 'resume', bindingId: binding.id,
                expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}} : {})}};
    return {schema: 2, dispatch, origin, request};
}

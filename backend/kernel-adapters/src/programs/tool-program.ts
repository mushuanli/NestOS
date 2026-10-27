import { interactionApproved, type Decision, type DurableTaskProgram, type TaskInputEvent } from '@itookit/durable-kernel';
import type { ToolInvokeResult } from '@itookit/tools/contracts';
export interface ToolProgramInput {
    toolId: string; toolVersion: string; args: Record<string, unknown>; allowedToolIds: string[];
    approval?: 'all' | 'none'; timeoutMs?: number;
    inputArgument?: string;
    inputs?: Record<string, unknown>;
    dependencies?: Array<{taskId: string; input: string; output?: string; injectOutput?: boolean; onFailure?: string}>;
}
interface State { input: ToolProgramInput; phase: 'capability' | 'approval' | 'effect'; handleId?: string; resolved?: string[] }
type Output = { outputs: { result: { outputName: 'result'; type: 'json'; content: unknown } } };
type ToolDecision = Decision<State, Output>;
/** Deterministic tools share the authorized tool.call Effect with Agents. */
export class ToolProgram implements DurableTaskProgram<State, ToolProgramInput, Output> {
    readonly manifest = { kind: 'kernel-adapters.tool', version: '1' };
    init(input: ToolProgramInput): ToolDecision {
        if (!input.toolId?.trim() || !input.toolVersion?.trim() || !input.allowedToolIds?.includes(input.toolId)) throw new Error('Tool identity, fixed version and authorization are required');
        if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new Error('Tool arguments must be an object');
        if (input.approval !== undefined && !['all', 'none'].includes(input.approval)) throw new Error('Invalid tool approval policy');
        if (input.inputArgument !== undefined && (typeof input.inputArgument !== 'string' || !input.inputArgument.trim())) throw new Error('Tool input argument must be a nonempty string');
        const frozen = structuredClone(input);
        frozen.args = mergeArguments(frozen.args, frozen.inputs?.input, frozen.inputArgument);
        return awaitingInputs({ input: frozen, phase: 'capability', resolved: [] });
    }
    reduce(state: Readonly<State>, event: TaskInputEvent): ToolDecision {
        if (state.phase === 'capability') {
            if (event.type === 'task-exited') return collectInput(state, event);
            if (event.type === 'signal' && event.signal.type === 'capabilities') return bind(state, event);
            return awaitingInputs(state);
        }
        if (state.phase === 'approval') {
            if (event.type !== 'interaction-resolved' || event.interactionId !== 'approve:tool' || !interactionApproved(event.value)) return fail(state, 'Tool approval denied');
            return invoke(state);
        }
        if (event.type === 'effect-failed') return { state: { ...state }, next: { type: 'fail', error: event.error } };
        if (event.type !== 'effect-completed' || event.effectId !== 'tool') return fail(state, 'Unexpected tool event');
        const result = event.result as ToolInvokeResult;
        if (!result?.success || result.data === undefined) return fail(state, result?.error ?? 'Complete structured result required', result?.errorCode ?? 'TOOL_OUTPUT_MISSING');
        return { state: { ...state }, next: { type: 'complete', output: { outputs: { result: { outputName: 'result', type: 'json', content: result.data } } } } };
    }
}
function bind(state: Readonly<State>, event: TaskInputEvent): ToolDecision {
    const payload = event.type === 'signal' && event.signal.type === 'capabilities' ? event.signal.payload : undefined;
    const handleId = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).toolHandleId : undefined;
    if (typeof handleId !== 'string' || !handleId) return fail(state, 'Tool resource handle required');
    return awaitingInputs({ ...state, handleId });
}
function awaitingInputs(state: Readonly<State>): ToolDecision {
    const pending = (state.input.dependencies ?? []).filter(binding => !state.resolved?.includes(binding.taskId));
    const waits: import('@itookit/durable-kernel').WaitSpec[] = pending.map(binding => ({ type: 'task', id: binding.taskId }));
    if (!state.handleId) waits.push({ type: 'signal', id: 'capabilities' });
    if (waits.length) return {state: {...state}, next: {type: 'wait', on: {type: 'all', waits}}};
    const next: State = { ...state, phase: 'approval' };
    if (state.input.approval === 'none') return invoke(next);
    return { state: next, actions: [{ type: 'request-interaction', interaction: { id: 'approve:tool', kind: 'approval', prompt: `Approve ${state.input.toolId}@${state.input.toolVersion}?` } }], next: { type: 'wait', on: { type: 'interaction', id: 'approve:tool' } } };
}
function collectInput(state: Readonly<State>, event: Extract<TaskInputEvent, {type: 'task-exited'}>): ToolDecision {
    const bindings = state.input.dependencies?.filter(item => item.taskId === event.taskId) ?? [];
    if (!bindings.length || state.resolved?.includes(event.taskId)) return awaitingInputs(state);
    const next: State = structuredClone(state);
    try {
        for (const binding of bindings) {
            if (binding.injectOutput === false) continue;
            if (event.exit.status !== 'succeeded') {
                if (binding.onFailure === 'continue') continue;
                return fail(state, 'Tool input dependency did not succeed', 'TOOL_INPUT_DEPENDENCY_FAILED');
            }
            if (binding.input !== 'input') return fail(state, 'Tool dependencies must target the input object', 'TOOL_INPUT_PORT_INVALID');
            const output = object(event.exit.output), artifact = object(object(output.outputs)[binding.output ?? 'result']);
            if (!Object.hasOwn(artifact, 'content')) return fail(state, 'Tool input dependency has no named output', 'TOOL_INPUT_OUTPUT_MISSING');
            next.input.args = mergeArguments(next.input.args, artifact.content, state.input.inputArgument);
        }
    } catch (error) { return fail(state, (error as Error).message, 'TOOL_INPUT_ARGUMENTS_INVALID'); }
    next.resolved = [...(state.resolved ?? []), event.taskId];
    return awaitingInputs(next);
}
function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function mergeArguments(args: Record<string, unknown>, value: unknown, name?: string): Record<string, unknown> {
    if (value === undefined) return args;
    if (name) value = {[name]: value};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool input must be an argument object');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => Object.hasOwn(args, key))) throw new Error('Tool input conflicts with configured arguments');
    return {...args, ...input};
}
function invoke(state: Readonly<State>): ToolDecision {
    const { toolId, toolVersion, args, timeoutMs } = state.input;
    return { state: { ...state, phase: 'effect' }, actions: [{ type: 'effect', effect: { id: 'tool', kind: 'tool.call', version: '1',
        request: { toolId, toolVersion, args, timeoutMs, resourceHandleId: state.handleId!, resultMode: 'structured' }, timeoutMs,
        idempotencyKey: 'tool', grants: [{ handleId: state.handleId!, right: 'execute' }] } }], next: { type: 'wait', on: { type: 'effect', id: 'tool' } } };
}
function fail(state: Readonly<State>, message: string, code = 'TOOL_EXECUTION_FAILED'): ToolDecision {
    return { state: { ...state }, actions: [{type: 'emit', eventType: 'tool.input.failed', payload: {
        operation: 'flow.tool', stage: state.phase, result: 'failure', code,
        toolId: state.input.toolId, dependencyCount: state.input.dependencies?.length ?? 0,
    }}], next: { type: 'fail', error: { message, code } } };
}

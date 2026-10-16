import { interactionApproved, type Decision, type DurableTaskProgram, type TaskInputEvent } from '@itookit/durable-kernel';
import type { ToolInvokeResult } from '@itookit/tools/contracts';
export interface ToolProgramInput { toolId: string; toolVersion: string; args: Record<string, unknown>; allowedToolIds: string[]; approval?: 'all' | 'none'; timeoutMs?: number }
interface State { input: ToolProgramInput; phase: 'capability' | 'approval' | 'effect'; handleId?: string }
type Output = { outputs: { result: { outputName: 'result'; type: 'json'; content: unknown } } };
type ToolDecision = Decision<State, Output>;
/** Deterministic tools share the authorized tool.call Effect with Agents. */
export class ToolProgram implements DurableTaskProgram<State, ToolProgramInput, Output> {
    readonly manifest = { kind: 'kernel-adapters.tool', version: '1' };
    init(input: ToolProgramInput): ToolDecision {
        if (!input.toolId?.trim() || !input.toolVersion?.trim() || !input.allowedToolIds?.includes(input.toolId)) throw new Error('Tool identity, fixed version and authorization are required');
        if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new Error('Tool arguments must be an object');
        if (input.approval !== undefined && !['all', 'none'].includes(input.approval)) throw new Error('Invalid tool approval policy');
        return { state: { input: structuredClone(input), phase: 'capability' }, next: { type: 'wait', on: { type: 'signal', id: 'capabilities' } } };
    }
    reduce(state: Readonly<State>, event: TaskInputEvent): ToolDecision {
        if (state.phase === 'capability') return bind(state, event);
        if (state.phase === 'approval') {
            if (event.type !== 'interaction-resolved' || event.interactionId !== 'approve:tool' || !interactionApproved(event.value)) return fail(state, 'Tool approval denied');
            return invoke(state);
        }
        if (event.type === 'effect-failed') return { state: { ...state }, next: { type: 'fail', error: event.error } };
        if (event.type !== 'effect-completed' || event.effectId !== 'tool') return fail(state, 'Unexpected tool event');
        const result = event.result as ToolInvokeResult;
        if (!result?.success || result.data === undefined) return fail(state, result?.error ?? 'Complete structured result required');
        return { state: { ...state }, next: { type: 'complete', output: { outputs: { result: { outputName: 'result', type: 'json', content: result.data } } } } };
    }
}
function bind(state: Readonly<State>, event: TaskInputEvent): ToolDecision {
    const payload = event.type === 'signal' && event.signal.type === 'capabilities' ? event.signal.payload : undefined;
    const handleId = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).toolHandleId : undefined;
    if (typeof handleId !== 'string' || !handleId) return fail(state, 'Tool resource handle required');
    const next: State = { ...state, handleId, phase: 'approval' };
    if (state.input.approval === 'none') return invoke(next);
    return { state: next, actions: [{ type: 'request-interaction', interaction: { id: 'approve:tool', kind: 'approval', prompt: `Approve ${state.input.toolId}@${state.input.toolVersion}?` } }], next: { type: 'wait', on: { type: 'interaction', id: 'approve:tool' } } };
}
function invoke(state: Readonly<State>): ToolDecision {
    const { toolId, toolVersion, args, timeoutMs } = state.input;
    return { state: { ...state, phase: 'effect' }, actions: [{ type: 'effect', effect: { id: 'tool', kind: 'tool.call', version: '1',
        request: { toolId, toolVersion, args, timeoutMs, resourceHandleId: state.handleId!, resultMode: 'structured' }, timeoutMs,
        idempotencyKey: 'tool', grants: [{ handleId: state.handleId!, right: 'execute' }] } }], next: { type: 'wait', on: { type: 'effect', id: 'tool' } } };
}
function fail(state: Readonly<State>, message: string): ToolDecision { return { state: { ...state }, next: { type: 'fail', error: { message } } }; }

import type { Decision, DurableTaskProgram, TaskInputEvent } from '@itookit/durable-kernel';
import type { LlmMediaEffectRequest, StoredMediaResult } from '../effects/llm-media-effect';
export type MediaProgramInput = Omit<LlmMediaEffectRequest, 'resourceHandleId'> & { timeoutMs?: number };
interface State { input: MediaProgramInput; phase: 'capability' | 'effect' }
type Output = { outputs: { result: { outputName: 'result'; type: 'json'; content: StoredMediaResult } } };
type MediaDecision = Decision<State, Output>;
/** A deterministic generation requires a separately granted LLM resource. */
export class MediaProgram implements DurableTaskProgram<State, MediaProgramInput, Output> {
    readonly manifest = { kind: 'kernel-adapters.media', version: '1' };
    init(input: MediaProgramInput): MediaDecision {
        if (!input.connectionId?.trim() || !input.request?.model || !['image.generate', 'speech.synthesize'].includes(input.request.operation)) throw new Error('Media operation requires explicit connection and model');
        if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647)) throw new Error('Invalid media effect timeout');
        return { state: { input: structuredClone(input), phase: 'capability' }, next: { type: 'wait', on: { type: 'signal', id: 'capabilities' } } };
    }
    reduce(state: Readonly<State>, event: TaskInputEvent): MediaDecision {
        if (state.phase === 'capability') return bind(state, event);
        if (event.type === 'effect-failed') return { state: { ...state }, next: { type: 'fail', error: event.error } };
        if (event.type !== 'effect-completed' || event.effectId !== 'media') throw new Error('Unexpected media event');
        return { state: { ...state }, next: { type: 'complete', output: { outputs: { result: { outputName: 'result', type: 'json', content: event.result as StoredMediaResult } } } } };
    }
}
function bind(state: Readonly<State>, event: TaskInputEvent): MediaDecision {
    const payload = event.type === 'signal' && event.signal.type === 'capabilities' ? event.signal.payload : undefined;
    const handleId = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).llmHandleId : undefined;
    if (typeof handleId !== 'string' || !handleId) throw new Error('Media LLM resource handle is required');
    return { state: { ...state, phase: 'effect' }, actions: [{ type: 'effect', effect: { id: 'media', kind: 'llm.media', version: '1',
        request: { ...state.input, resourceHandleId: handleId }, timeoutMs: state.input.timeoutMs ?? 180_000, idempotencyKey: 'media', grants: [{ handleId, right: 'execute' }] } }], next: { type: 'wait', on: { type: 'effect', id: 'media' } } };
}

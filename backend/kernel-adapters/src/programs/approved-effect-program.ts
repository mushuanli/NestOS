import { interactionApproved } from '@itookit/durable-kernel';
import type {
    Decision,
    DurableTaskProgram,
    EffectRequest,
    JsonValue,
    SerializableError,
    TaskInputEvent,
} from '@itookit/durable-kernel';

export interface ApprovedEffectInput {
    effect: EffectRequest & { id: string };
    prompt: string;
    title?: string;
    details?: JsonValue;
}

interface ApprovedEffectState {
    effect: EffectRequest & { id: string };
    phase: 'approval' | 'effect';
}

export class ApprovedEffectProgram implements DurableTaskProgram<ApprovedEffectState, ApprovedEffectInput, unknown> {
    readonly manifest = { kind: 'kernel-adapters.approved-effect', version: '1' };

    init(input: ApprovedEffectInput): Decision<ApprovedEffectState, unknown> {
        validateInput(input);
        return {
            state: { effect: input.effect, phase: 'approval' },
            actions: [{
                type: 'request-interaction',
                interaction: {
                    id: approvalId(input.effect.id),
                    kind: 'approval',
                    prompt: input.prompt,
                    payload: interactionPayload(input),
                },
            }],
            next: { type: 'wait', on: { type: 'interaction', id: approvalId(input.effect.id) } },
        };
    }

    reduce(
        state: Readonly<ApprovedEffectState>,
        event: TaskInputEvent,
    ): Decision<ApprovedEffectState, unknown> {
        if (state.phase === 'approval') return handleApproval(state, event);
        if (event.type === 'effect-completed') {
            return { state: { ...state }, next: { type: 'complete', output: event.result } };
        }
        if (event.type === 'effect-failed') {
            return { state: { ...state }, next: { type: 'fail', error: event.error } };
        }
        return unexpected(state, event);
    }
}

function handleApproval(
    state: Readonly<ApprovedEffectState>,
    event: TaskInputEvent,
): Decision<ApprovedEffectState, unknown> {
    if (event.type !== 'interaction-resolved') return unexpected(state, event);
    if (!interactionApproved(event.value)) {
        return {
            state: { ...state },
            next: { type: 'fail', error: { message: 'Effect approval was denied', code: 'APPROVAL_DENIED' } },
        };
    }
    return {
        state: { effect: state.effect, phase: 'effect' },
        actions: [{ type: 'effect', effect: state.effect }],
        next: { type: 'wait', on: { type: 'effect', id: state.effect.id } },
    };
}

function validateInput(input: ApprovedEffectInput): void {
    if (!input.prompt.trim()) throw new Error('Approval prompt is required');
    if (!input.effect.id) throw new Error('Approved Effect requires a stable effect id');
}

function approvalId(effectId: string): string { return `approve:${effectId}`; }

function interactionPayload(input: ApprovedEffectInput): JsonValue {
    const payload: Record<string, JsonValue> = {};
    if (input.title !== undefined) payload.title = input.title;
    if (input.details !== undefined) payload.details = input.details;
    return payload;
}

function unexpected(
    state: Readonly<ApprovedEffectState>,
    event: TaskInputEvent,
): Decision<ApprovedEffectState, unknown> {
    const error: SerializableError = { message: `Unexpected event while waiting for ${state.phase}: ${event.type}` };
    return { state: { ...state }, next: { type: 'fail', error } };
}

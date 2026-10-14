import {
    interactionApproved,
    type Decision,
    type DurableTaskProgram,
    type SerializableError,
    type TaskInputEvent,
} from '@itookit/durable-kernel';
import { assistantMessage, capabilitySignal, llmEffect, response } from './program-helpers';
import type { DurableCapabilitySignal, DurableProgramInput } from './types';

export interface DurablePlanInput extends Omit<DurableProgramInput, 'messages'> {
    goal: string;
}

export interface DurablePlanOutput {
    plan: string;
    approved: boolean;
}

interface PlanState {
    input: DurablePlanInput;
    phase: 'capability' | 'llm' | 'approval';
    capabilities?: DurableCapabilitySignal;
    plan?: string;
}

const APPROVAL_ID = 'approve:plan';
const LLM_EFFECT_ID = 'llm-2';

export class DurablePlanProgram implements DurableTaskProgram<PlanState, DurablePlanInput, DurablePlanOutput> {
    readonly manifest = { kind: 'llm.plan', version: '1' };

    init(input: DurablePlanInput): Decision<PlanState, DurablePlanOutput> {
        validate(input);
        return {
            state: { input: structuredClone(input), phase: 'capability' },
            next: { type: 'wait', on: { type: 'signal', id: 'capabilities' } },
        };
    }

    reduce(
        state: Readonly<PlanState>,
        event: TaskInputEvent,
    ): Decision<PlanState, DurablePlanOutput> {
        if (state.phase === 'capability') return createPlan(state, event);
        if (state.phase === 'llm') return requestApproval(state, event);
        return finishApproval(state, event);
    }
}

function createPlan(
    state: Readonly<PlanState>,
    event: TaskInputEvent,
): Decision<PlanState, DurablePlanOutput> {
    const capabilities = capabilitySignal(event);
    if (!capabilities) return unexpected(state, event);
    const input: DurableProgramInput = { ...state.input, messages: planMessages(state.input.goal) };
    return {
        state: { ...state, capabilities, phase: 'llm' },
        actions: [llmEffect(input, input.messages, capabilities.llmHandleId)],
        next: { type: 'wait', on: { type: 'effect', id: LLM_EFFECT_ID } },
    };
}

function requestApproval(
    state: Readonly<PlanState>,
    event: TaskInputEvent,
): Decision<PlanState, DurablePlanOutput> {
    if (event.type === 'effect-failed') {
        return { state: { ...state }, next: { type: 'fail', error: event.error } };
    }
    if (event.type !== 'effect-completed') return unexpected(state, event);
    const plan = String(assistantMessage(response(event)).content ?? '').trim();
    if (!plan) return failed(state, 'Planner returned an empty plan');
    return {
        state: { ...state, plan, phase: 'approval' },
        actions: [{
            type: 'request-interaction',
            interaction: {
                id: APPROVAL_ID,
                kind: 'approval',
                prompt: 'Review and approve the generated plan',
                payload: { plan },
            },
        }],
        next: { type: 'wait', on: { type: 'interaction', id: APPROVAL_ID } },
    };
}

function finishApproval(
    state: Readonly<PlanState>,
    event: TaskInputEvent,
): Decision<PlanState, DurablePlanOutput> {
    if (event.type !== 'interaction-resolved') return unexpected(state, event);
    return {
        state: { ...state },
        next: {
            type: 'complete',
            output: { plan: state.plan!, approved: interactionApproved(event.value) },
        },
    };
}

function planMessages(goal: string): DurableProgramInput['messages'] {
    return [
        {
            role: 'system',
            content: 'Create a concise, actionable implementation plan. Do not execute tools or modify files.',
        },
        { role: 'user', content: goal },
    ];
}

function validate(input: DurablePlanInput): void {
    if (!input.goal?.trim()) throw new Error('Plan goal is required');
    if (!input.sessionId || !input.roundId || !input.connectionId) {
        throw new Error('Plan requires sessionId, roundId and connectionId');
    }
}

function failed(
    state: Readonly<PlanState>,
    message: string,
): Decision<PlanState, DurablePlanOutput> {
    return { state: { ...state }, next: { type: 'fail', error: { message } } };
}

function unexpected(
    state: Readonly<PlanState>,
    event: TaskInputEvent,
): Decision<PlanState, DurablePlanOutput> {
    const error: SerializableError = { message: `Unexpected ${event.type} event during ${state.phase}` };
    return { state: { ...state }, next: { type: 'fail', error } };
}

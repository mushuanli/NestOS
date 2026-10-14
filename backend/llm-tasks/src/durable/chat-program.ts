import type {
    Decision,
    DurableTaskProgram,
    JsonValue,
    TaskInputEvent,
} from '@itookit/durable-kernel';
import {
    CAPABILITY_SIGNAL,
    applyDependencyMessages,
    assistantMessage,
    capabilitySignal,
    emit,
    llmEffect,
    response,
    responseEvents,
    roundEvent,
} from './program-helpers';
import { collectDependency, dependenciesReady, dependencyWait } from './dependency-collector';
import type {
    DurableCapabilitySignal,
    DurableChatOutput,
    DurableProgramInput,
} from './types';

interface ChatState {
    input: DurableProgramInput;
    phase: 'collecting' | 'llm';
    dependencyOutputs: Record<string, JsonValue>;
    resolvedDependencyIds: string[];
    capabilities?: DurableCapabilitySignal;
}

export class DurableChatProgram implements DurableTaskProgram<ChatState, DurableProgramInput, DurableChatOutput> {
    readonly manifest = { kind: 'llm.chat', version: '1' };

    init(input: DurableProgramInput): Decision<ChatState, DurableChatOutput> {
        validate(input);
        return {
            state: {
                input: clone(input), phase: 'collecting',
                dependencyOutputs: {}, resolvedDependencyIds: [],
            },
            next: { type: 'wait', on: { type: 'signal', id: CAPABILITY_SIGNAL } },
        };
    }

    reduce(state: Readonly<ChatState>, event: TaskInputEvent): Decision<ChatState, DurableChatOutput> {
        if (state.phase === 'llm') return finish(state, event);
        const next = clone(state) as ChatState;
        collectDependency(next.input.dependencyBindings ?? [], next.dependencyOutputs, next.resolvedDependencyIds, event);
        const capabilities = capabilitySignal(event);
        if (capabilities) next.capabilities = capabilities;
        if (!next.capabilities || !dependenciesReady(next.input.dependencyBindings ?? [], next.resolvedDependencyIds)) {
            return { state: next, next: waitForInput(next) };
        }
        const messages = applyDependencyMessages(next.input, next.dependencyOutputs);
        next.phase = 'llm';
        return {
            state: next,
            actions: [
                emit(roundEvent('round:start', next.input)),
                llmEffect(next.input, messages, next.capabilities.llmHandleId),
            ],
            next: { type: 'wait', on: { type: 'effect', id: `llm-${messages.length}` } },
        };
    }
}

function finish(
    state: Readonly<ChatState>,
    event: TaskInputEvent,
): Decision<ChatState, DurableChatOutput> {
    if (event.type === 'effect-failed') return { state: clone(state), next: { type: 'fail', error: event.error } };
    const value = response(event);
    return {
        state: clone(state),
        actions: responseEvents(state.input),
        next: {
            type: 'complete',
            output: {
                message: assistantMessage(value),
                usage: value.usage ?? {},
                finishReason: value.choices[0].finish_reason,
            },
        },
    };
}

function waitForInput(state: ChatState): Decision<ChatState, DurableChatOutput>['next'] {
    if (!state.capabilities) return { type: 'wait', on: { type: 'signal', id: CAPABILITY_SIGNAL } };
    const bindings = state.input.dependencyBindings ?? [];
    return bindings.length ? dependencyWait(bindings) : { type: 'continue' };
}

function validate(input: DurableProgramInput): void {
    if (!input.sessionId || !input.roundId || !input.connectionId) {
        throw new Error('DurableChatProgram requires sessionId, roundId and connectionId');
    }
    if (!input.messages.length) throw new Error('DurableChatProgram requires messages');
}

function clone<T>(value: T): T { return structuredClone(value); }

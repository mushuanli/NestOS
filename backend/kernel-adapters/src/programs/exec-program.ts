import {
    interactionApproved,
    type Decision,
    type DurableTaskProgram,
    type JsonValue,
    type SerializableError,
    type TaskInputEvent,
} from '@itookit/durable-kernel';

export interface ExecProgramInput {
    command: string;
    cwd?: string;
    timeoutMs?: number;
}

export interface ExecProgramOutput {
    result: JsonValue;
}

interface ExecProgramState {
    input: ExecProgramInput;
    phase: 'capability' | 'approval' | 'effect';
    processHandleId?: string;
}

const CAPABILITY_SIGNAL = 'capabilities';
const APPROVAL_ID = 'approve:exec';
const EFFECT_ID = 'exec';

export class ExecProgram implements DurableTaskProgram<ExecProgramState, ExecProgramInput, ExecProgramOutput> {
    readonly manifest = { kind: 'kernel-adapters.exec', version: '1' };

    init(input: ExecProgramInput): Decision<ExecProgramState, ExecProgramOutput> {
        validate(input);
        return {
            state: { input: structuredClone(input), phase: 'capability' },
            next: { type: 'wait', on: { type: 'signal', id: CAPABILITY_SIGNAL } },
        };
    }

    reduce(
        state: Readonly<ExecProgramState>,
        event: TaskInputEvent,
    ): Decision<ExecProgramState, ExecProgramOutput> {
        if (state.phase === 'capability') return bindCapability(state, event);
        if (state.phase === 'approval') return approve(state, event);
        return finish(state, event);
    }
}

function bindCapability(
    state: Readonly<ExecProgramState>,
    event: TaskInputEvent,
): Decision<ExecProgramState, ExecProgramOutput> {
    const processHandleId = readProcessHandle(event);
    const next = { ...state, phase: 'approval' as const, processHandleId };
    return {
        state: next,
        actions: [{
            type: 'request-interaction',
            interaction: {
                id: APPROVAL_ID,
                kind: 'approval',
                prompt: `Approve command execution?\n${state.input.command}`,
                payload: commandDetails(state.input),
            },
        }],
        next: { type: 'wait', on: { type: 'interaction', id: APPROVAL_ID } },
    };
}

function approve(
    state: Readonly<ExecProgramState>,
    event: TaskInputEvent,
): Decision<ExecProgramState, ExecProgramOutput> {
    if (event.type !== 'interaction-resolved') return unexpected(state, event);
    if (!interactionApproved(event.value)) return denied(state);
    const handleId = state.processHandleId!;
    return {
        state: { ...state, phase: 'effect' },
        actions: [{
            type: 'effect',
            effect: {
                id: EFFECT_ID,
                kind: 'process.exec',
                version: '1',
                request: { resourceHandleId: handleId, ...state.input },
                idempotencyKey: `exec:${state.input.command}`,
                timeoutMs: state.input.timeoutMs,
                grants: [{ handleId, right: 'execute' }],
            },
        }],
        next: { type: 'wait', on: { type: 'effect', id: EFFECT_ID } },
    };
}

function finish(
    state: Readonly<ExecProgramState>,
    event: TaskInputEvent,
): Decision<ExecProgramState, ExecProgramOutput> {
    if (event.type === 'effect-failed') {
        return { state: { ...state }, next: { type: 'fail', error: event.error } };
    }
    if (event.type !== 'effect-completed') return unexpected(state, event);
    return {
        state: { ...state },
        next: { type: 'complete', output: { result: toJson(event.result) } },
    };
}

function readProcessHandle(event: TaskInputEvent): string {
    if (event.type !== 'signal' || event.signal.type !== CAPABILITY_SIGNAL) {
        throw new Error(`Expected ${CAPABILITY_SIGNAL} signal`);
    }
    const payload = event.signal.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Process resource handle is required');
    }
    const value = (payload as Record<string, unknown>).processHandleId;
    if (typeof value !== 'string' || !value) throw new Error('Process resource handle is required');
    return value;
}

function validate(input: ExecProgramInput): void {
    if (!input.command?.trim()) throw new Error('Command is required');
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
        throw new Error('Command timeout must be a positive number');
    }
}

function denied(state: Readonly<ExecProgramState>): Decision<ExecProgramState, ExecProgramOutput> {
    return {
        state: { ...state },
        next: { type: 'fail', error: { message: 'Command approval was denied', code: 'APPROVAL_DENIED' } },
    };
}

function unexpected(
    state: Readonly<ExecProgramState>,
    event: TaskInputEvent,
): Decision<ExecProgramState, ExecProgramOutput> {
    const error: SerializableError = { message: `Unexpected ${event.type} event during ${state.phase}` };
    return { state: { ...state }, next: { type: 'fail', error } };
}

function commandDetails(input: ExecProgramInput): JsonValue {
    return {
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    };
}

function toJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

import type { Decision, DurableTaskProgram, JsonValue, TaskInputEvent, WaitSpec } from '@itookit/durable-kernel';
import type { HarnessConnectionSnapshot, HarnessExecutionRequest, HarnessExecutionResult,
    HarnessInteractionNotification } from '../llm-management/contracts/harness-execution';

export interface HarnessProgramInput {
    connection: HarnessConnectionSnapshot;
    messages?: Array<{ role: string; content: unknown }>;
    prompt?: string;
    dependencies?: Array<{ taskId: string; input: string; output?: string; injectOutput?: boolean }>;
    includeDependencyOutputs?: boolean;
    timeoutMs?: number;
}
interface State {
    input: HarnessProgramInput;
    resolved: string[];
    dependencyOutputs: Record<string, JsonValue>;
    handleId?: string;
    notificationKey?: string;
    notificationVersion: number;
    interactionId?: string;
    running: boolean;
}
type Output = { message: { role: 'assistant'; content: string }; usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    outputs: { result: { outputName: 'result'; type: 'text'; content: string } }; harness: HarnessExecutionResult };
type Result = Decision<State, Output>;

/** One active Effect owns the native turn, including while a durable Interaction is waiting. */
export class HarnessProgram implements DurableTaskProgram<State, HarnessProgramInput, Output> {
    readonly manifest = { kind: 'kernel-adapters.harness', version: '1' };
    init(input: HarnessProgramInput): Result {
        validateInput(input);
        return ready({ input: structuredClone(input), resolved: [], dependencyOutputs: {}, notificationVersion: 0, running: false });
    }
    reduce(previous: Readonly<State>, event: TaskInputEvent): Result {
        const state: State = { ...structuredClone(previous) };
        if (event.type === 'effect-failed' && event.effectId === 'harness') return { state, next: { type: 'fail', error: event.error } };
        if (event.type === 'effect-completed' && event.effectId === 'harness') return completed(state, event.result);
        if (event.type === 'signal' && event.signal.type === 'capabilities') {
            const handle = record(event.signal.payload).harnessHandleId;
            if (typeof handle !== 'string' || !handle) return failed(state, 'HARNESS_CAPABILITY_REQUIRED');
            state.handleId = handle;
        }
        if (event.type === 'task-exited') collectDependency(state, event);
        if (!state.running) return ready(state);
        if (event.type === 'shared-changed' && event.revision.key === state.notificationKey) return notification(state, event.revision);
        if (event.type === 'interaction-resolved' && event.interactionId === state.interactionId) return respond(state, event.value);
        return waiting(state);
    }
}

function ready(state: State): Result {
    const pending = (state.input.dependencies ?? []).filter(item => !state.resolved.includes(item.taskId));
    if (pending.length) return { state, next: { type: 'wait', on: { type: 'all', waits: pending.map(item => ({ type: 'task', id: item.taskId })) } } };
    if (!state.handleId) return { state, next: { type: 'wait', on: { type: 'signal', id: 'capabilities' } } };
    state.running = true;
    state.notificationKey = `harness.execution.${state.handleId}`;
    const request: HarnessExecutionRequest = { connection: state.input.connection, prompt: prompt(state),
        resourceHandleId: state.handleId, notificationKey: state.notificationKey };
    return { ...waiting(state), actions: [{ type: 'effect', effect: { id: 'harness', kind: 'harness.execute', version: '1',
        request, idempotencyKey: 'harness', timeoutMs: state.input.timeoutMs ?? 1_800_000,
        grants: [{ handleId: state.handleId, right: 'execute' }] } }] };
}

function waiting(state: State): Result {
    const waits: WaitSpec[] = [{ type: 'effect', id: 'harness' }];
    if (state.interactionId) waits.push({ type: 'interaction', id: state.interactionId });
    else waits.push({ type: 'shared-version', key: state.notificationKey!, afterVersion: state.notificationVersion });
    return { state, next: { type: 'wait', on: { type: 'any', waits } } };
}

function notification(state: State, revision: { version: number; value?: JsonValue; deleted: boolean }): Result {
    if (revision.version <= state.notificationVersion) return waiting(state);
    state.notificationVersion = revision.version;
    const value = record(revision.value);
    if (revision.deleted || typeof value.id !== 'string' || !value.id || typeof value.prompt !== 'string'
        || !['approval', 'input'].includes(String(value.kind))) return failed(state, 'HARNESS_INTERACTION_INVALID');
    const request = value as unknown as HarnessInteractionNotification;
    state.interactionId = `harness:${encodeURIComponent(request.id)}`;
    return { ...waiting(state), actions: [{ type: 'request-interaction', interaction: {
        id: state.interactionId, kind: request.kind, prompt: request.prompt, ...(request.payload !== undefined ? { payload: request.payload } : {}),
    } }] };
}

function respond(state: State, value: JsonValue): Result {
    const id = decodeURIComponent(state.interactionId!.slice('harness:'.length));
    state.interactionId = undefined;
    return { ...waiting(state), actions: [{ type: 'set-shared',
        key: `${state.notificationKey}.response.${encodeURIComponent(id)}`, value, expectedVersion: null }] };
}

function collectDependency(state: State, event: Extract<TaskInputEvent, { type: 'task-exited' }>): void {
    const binding = state.input.dependencies?.find(item => item.taskId === event.taskId);
    if (!binding || state.resolved.includes(binding.taskId)) return;
    state.resolved.push(binding.taskId);
    if (binding.injectOutput === false) return;
    const output = record(event.exit.output), artifact = record(record(output.outputs)[binding.output ?? 'result']);
    const value = artifact.content ?? output.message ?? event.exit.output ?? null;
    state.dependencyOutputs[binding.input] = JSON.parse(JSON.stringify(value)) as JsonValue;
}

function prompt(state: State): string {
    const messages = state.input.messages?.map(item => ({ role: item.role, content: text(item.content) }))
        ?? [{ role: 'user', content: state.input.prompt ?? '' }];
    const dependencies = state.input.includeDependencyOutputs === false ? {} : state.dependencyOutputs;
    if (Object.keys(dependencies).length) messages.push({ role: 'user', content: JSON.stringify({ dependencies }) });
    return messages.length === 1 && messages[0].role === 'user' ? messages[0].content : JSON.stringify({ messages });
}

function text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every(item => record(item).type === 'text' && typeof record(item).text === 'string')) {
        return value.map(item => record(item).text).join('\n');
    }
    throw new Error('HARNESS_TEXT_MESSAGES_REQUIRED');
}

function validateInput(input: HarnessProgramInput): void {
    if (!validConnection(input.connection)) throw new Error('HARNESS_CONNECTION_INVALID');
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) throw new Error('HARNESS_TIMEOUT_INVALID');
    for (const message of input.messages ?? []) {
        if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('HARNESS_MESSAGE_ROLE_INVALID');
        text(message.content);
    }
}

function validConnection(value: HarnessConnectionSnapshot): boolean {
    return !!value && value.version === 1 && value.kind === 'harness' && validRevision(value)
        && [value.id, value.nodeConnectionId, value.projectId, value.profileId].every(item => typeof item === 'string' && !!item);
}
function validRevision(value: HarnessConnectionSnapshot): boolean {
    return Number.isSafeInteger(value.revision) && value.revision >= 1 && value.enabled !== false;
}

function completed(state: State, result: unknown): Result {
    const value = record(result);
    if (typeof value.text !== 'string' || typeof value.sessionId !== 'string' || !value.sessionId
        || typeof value.turnId !== 'string' || !value.turnId) return failed(state, 'HARNESS_RESULT_INVALID');
    return { state, next: { type: 'complete', output: { message: { role: 'assistant', content: value.text },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        outputs: { result: { outputName: 'result', type: 'text', content: value.text } }, harness: result as HarnessExecutionResult } } };
}
function failed(state: State, code: string): Result { return { state, next: { type: 'fail', error: { message: code, code } } }; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

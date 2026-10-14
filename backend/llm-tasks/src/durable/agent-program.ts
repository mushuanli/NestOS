import { DEFAULT_AGENT_MAX_EXCHANGES } from '../contracts';
import { type ChatMessage, type ToolCall } from '@itookit/llm-context';
import { type ToolInvokeResult } from '@itookit/tools/contracts';
import {
    interactionApproved,
    type Decision,
    type DurableTaskProgram,
    type JsonValue,
    type KernelAction,
    type TaskInputEvent,
} from '@itookit/durable-kernel';
import {
    CAPABILITY_SIGNAL,
    addUsage,
    applyDependencyMessages,
    assistantMessage,
    capabilitySignal,
    emit,
    llmEffect,
    response,
    responseEvents,
    roundEvent,
    toolArguments,
    toolCalls,
    toolEffect,
    toolEffectId,
    toolName,
} from './program-helpers';
import { collectDependency, dependenciesReady, dependencyWait } from './dependency-collector';
import { compactMessages, validateContextCompaction } from '@itookit/llm-context';
import type {
    DurableAgentInput,
    DurableAgentOutput,
    DurableAgentState,
} from './types';

export class DurableAgentProgram implements DurableTaskProgram<DurableAgentState, DurableAgentInput, DurableAgentOutput> {
    readonly manifest = { kind: 'llm.agent', version: '1' };

    init(input: DurableAgentInput): Decision<DurableAgentState, DurableAgentOutput> {
        validate(input);
        validateContextCompaction(input.contextCompaction);
        return {
            state: initialState(input),
            next: { type: 'wait', on: { type: 'signal', id: CAPABILITY_SIGNAL } },
        };
    }

    reduce(
        current: Readonly<DurableAgentState>,
        event: TaskInputEvent,
    ): Decision<DurableAgentState, DurableAgentOutput> {
        const state = clone(current) as DurableAgentState;
        if (state.phase === 'collecting') return collect(state, event);
        if (state.phase === 'llm') return handleLlm(state, event);
        if (state.phase === 'tool') return handleTool(state, event);
        if (state.phase === 'approval' || state.phase === 'human') return handleInteraction(state, event);
        return fail(state, `Unsupported Agent phase: ${state.phase}`);
    }
}

function collect(state: DurableAgentState, event: TaskInputEvent): Decision<DurableAgentState, DurableAgentOutput> {
    collectDependency(state.input.dependencyBindings ?? [], state.dependencyOutputs, state.resolvedDependencyIds, event);
    const capabilities = capabilitySignal(event);
    if (capabilities) state.capabilities = capabilities;
    if (!state.capabilities || !dependenciesReady(state.input.dependencyBindings ?? [], state.resolvedDependencyIds)) {
        return { state, next: waitForInput(state) };
    }
    state.messages = applyDependencyMessages(state.input, state.dependencyOutputs);
    return requestLlm(state);
}

function requestLlm(state: DurableAgentState): Decision<DurableAgentState, DurableAgentOutput> {
    if (state.exchanges >= (state.input.maxExchanges ?? DEFAULT_AGENT_MAX_EXCHANGES)) {
        return fail(state, `Agent exchange budget exhausted (${state.exchanges}/${state.input.maxExchanges ?? DEFAULT_AGENT_MAX_EXCHANGES}); increase maxExchanges for tool follow-ups or output repair`, 'BUDGET_EXHAUSTED');
    }
    state.exchanges++;
    state.messages = compactMessages(state.messages, state.input.contextCompaction);
    const effectId = `llm-exchange-${state.exchanges}`;
    const skillMessages: ChatMessage[] = (state.skillContexts ?? [])
        .filter(skill => skill.compactInstructions.trim())
        .map(skill => ({ role: 'system', content: `Skill ${skill.skillId} — critical rules:\n${skill.compactInstructions}` }));
    state.phase = 'llm';
    return {
        state,
        actions: [
            emit(roundEvent('round:start', state.input, state.exchanges)),
            llmEffect(state.input, [...skillMessages, ...state.messages], state.capabilities!.llmHandleId, effectiveTools(state), effectId),
        ],
        next: { type: 'wait', on: { type: 'effect', id: effectId } },
    };
}

function handleLlm(state: DurableAgentState, event: TaskInputEvent): Decision<DurableAgentState, DurableAgentOutput> {
    if (event.type === 'effect-failed') return { state, next: { type: 'fail', error: event.error } };
    const value = response(event);
    const message = assistantMessage(value);
    state.messages.push(message);
    state.usage = addUsage(state.usage, value.usage);
    const calls = toolCalls(value);
    const invalidCalls = validateToolCalls(calls);
    if (invalidCalls) return fail(state, invalidCalls, 'INVALID_TOOL_CALLS');
    const actions = responseEvents(state.input, state.exchanges);
    if (!calls.length) {
        const issue = outputValidationIssue(state.input, message.content);
        if (issue) {
            actions.push(outputValidationDiagnostic(state, value, issue));
            return handleInvalidOutput(state, issue, actions);
        }
        return complete(state, message, value.choices[0].finish_reason, actions);
    }
    // Subtask delegation: a subtask tool call declares sub-task payloads and
    // completes the node without executing the tool (fan-out happens upstream).
    const subtaskCall = state.input.subtaskTool
        ? calls.find(call => toolName(call) === state.input.subtaskTool)
        : undefined;
    if (subtaskCall) {
        const args = toolArguments(subtaskCall);
        const payload = Array.isArray(args.items) ? args.items : [];
        return complete(state, { ...message, content: JSON.stringify(payload) }, 'stop', actions);
    }
    state.pendingCalls = calls;
    state.callIndex = 0;
    state.approvedCallKeys = [];
    state.approvalProtocol = 2;
    state.pendingApprovalInteractionId = undefined;
    return prepareCalls(state, actions);
}

function prepareCalls(
    state: DurableAgentState,
    actions: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    const human = state.pendingCalls.find(call => isHumanTool(toolName(call)));
    if (human) return requestInteraction(state, human, true, actions);
    return dispatchNextCall(state, actions);
}

/** Re-evaluate approval against the latest tool metadata before every tool Effect. */
function dispatchNextCall(
    state: DurableAgentState,
    actions: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    const call = state.pendingCalls[state.callIndex];
    if (!call) return fail(state, 'Pending tool call is missing');
    const allowed = state.input.allowedToolIds;
    if (allowed && !allowed.includes(toolName(call)) && !loadedTools(state).some(tool =>
        (tool.definition.function?.name ?? tool.definition.name) === toolName(call))) {
        return fail(state, `Tool is not authorized for this task: ${toolName(call)}`, 'TOOL_NOT_ALLOWED');
    }
    if (requiresApproval(state, call) && !isCallApproved(state, call)) {
        return requestInteraction(state, call, false, actions);
    }
    return requestTool(state, actions);
}

function requestInteraction(
    state: DurableAgentState,
    call: ToolCall,
    human: boolean,
    actions: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    state.phase = human ? 'human' : 'approval';
    const args = toolArguments(call);
    const interactionId = human ? call.id : approvalInteractionId(state, call);
    state.approvalProtocol = 2;
    state.pendingApprovalInteractionId = interactionId;
    actions.push({
        type: 'request-interaction',
        interaction: {
            id: interactionId,
            kind: human ? 'input' : 'approval',
            prompt: interactionPrompt(args, human),
            payload: jsonValue(human
                ? { questions: args.questions ?? null, options: args.options ?? null }
                : { callId: call.id, calls: [{ tool: toolName(call), args }] }),
        },
    });
    return { state, actions, next: { type: 'wait', on: { type: 'interaction', id: interactionId } } };
}

function interactionPrompt(args: Record<string, unknown>, human: boolean): string {
    if (typeof args.question === 'string') return args.question;
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const first = questions[0];
    if (first && typeof first === 'object' && typeof (first as { question?: unknown }).question === 'string') {
        return (first as { question: string }).question;
    }
    return human ? 'Please provide input.' : 'Authorize tool execution?';
}

function handleInteraction(
    state: DurableAgentState,
    event: TaskInputEvent,
): Decision<DurableAgentState, DurableAgentOutput> {
    if (event.type !== 'interaction-resolved') return fail(state, `Expected interaction, received ${event.type}`);
    if (state.phase === 'approval') {
        const call = state.pendingCalls[state.callIndex];
        if (!call) return fail(state, 'Pending tool call is missing');
        // Legacy tasks persisted call.id as the approval interaction ID and may
        // predate approvalProtocol/approvedCallKeys. Only that exact call ID is
        // accepted, then the state is migrated to the current protocol.
        const legacy = state.approvalProtocol !== 2 && state.approvedCallKeys === undefined;
        const expectedInteractionId = legacy
            ? call.id
            : state.pendingApprovalInteractionId ?? approvalInteractionId(state, call);
        if (event.interactionId !== expectedInteractionId) {
            return fail(state, `Unexpected approval interaction: ${event.interactionId}`);
        }
        state.approvalProtocol = 2;
        state.pendingApprovalInteractionId = undefined;
        if (!interactionApproved(event.value)) {
            appendRejected(state, 'Tool execution was not authorized');
            state.phase = 'collecting';
            return requestLlm(state);
        }
        state.approvedCallKeys = [...new Set([...(state.approvedCallKeys ?? []), approvalKey(state, call)])];
        return dispatchNextCall(state, []);
    }
    if (state.phase === 'human') {
        appendHumanResponse(state, event.value);
        state.phase = 'collecting';
        return requestLlm(state);
    }
    return fail(state, `Unexpected interaction phase: ${state.phase}`);
}

function requestTool(
    state: DurableAgentState,
    actions: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    const call = state.pendingCalls[state.callIndex];
    const handle = state.capabilities?.toolHandleId;
    if (!call || !handle) return fail(state, 'Tool resource handle is required');
    state.phase = 'tool';
    actions.push(emit({ type: 'tool:running', call: callInfo(call) }));
    actions.push(toolEffect(state.input.roundId, state.exchanges, call, handle, state.input.workingDirectory, state.input.toolTimeoutMs));
    return { state, actions, next: { type: 'wait', on: { type: 'effect', id: toolEffectId(state.exchanges, call) } } };
}

function handleTool(state: DurableAgentState, event: TaskInputEvent): Decision<DurableAgentState, DurableAgentOutput> {
    const call = state.pendingCalls[state.callIndex];
    if (!call) return fail(state, 'Pending tool call is missing');
    if (event.type === 'effect-failed') return { state,
        actions: [emit({ type: 'tool:error', call: { ...callInfo(call), error: event.error.message } })],
        next: { type: 'fail', error: event.error } };
    if (event.type !== 'effect-completed') return fail(state, `Expected Tool Effect, received ${event.type}`);
    const result = event.result as ToolInvokeResult;
    if (!result.success && result.recoverable !== true) return fail(state, result.error ?? result.output, result.errorCode);
    if (result.success && result.skillContext) {
        state.skillContexts = (state.skillContexts ?? []).filter(skill => skill.skillId !== result.skillContext!.skillId);
        state.skillContexts.push(result.skillContext);
    }
    state.messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
    const actions = [emit(result.success
        ? { type: 'tool:success', call: { ...callInfo(call), result: result.output } }
        : { type: 'tool:error', call: { ...callInfo(call), error: result.error ?? result.output } })];
    state.callIndex++;
    if (state.callIndex < state.pendingCalls.length) return dispatchNextCall(state, actions);
    state.pendingCalls = [];
    state.approvedCallKeys = [];
    state.approvalProtocol = 2;
    state.pendingApprovalInteractionId = undefined;
    state.phase = 'collecting';
    return withActions(requestLlm(state), actions);
}

function complete(
    state: DurableAgentState,
    message: ChatMessage,
    finishReason: string | null,
    actions: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    actions.push(emit({ type: 'finished', usage: state.usage }));
    return {
        state,
        actions,
        next: { type: 'complete', output: { message, usage: state.usage, finishReason, exchanges: state.exchanges, ...structuredResult(state, message) } },
    };
}

function structuredResult(state: DurableAgentState, message: ChatMessage): Pick<DurableAgentOutput, 'outputs'> {
    if (state.input.responseFormat?.type !== 'json_schema' || typeof message.content !== 'string') return {};
    try { return { outputs: { result: { content: JSON.parse(message.content), type: 'json' } } }; }
    catch { return {}; }
}

function handleInvalidOutput(
    state: DurableAgentState,
    issue: string,
    actions: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    const policy = state.input.outputValidation;
    if (policy?.onInvalid === 'continue') {
        return complete(state, state.messages[state.messages.length - 1], 'stop', actions);
    }
    const retries = Math.max(0, Math.floor(policy?.retries ?? (policy?.onInvalid === 'repair' ? 3 : 0)));
    if (policy?.onInvalid === 'repair' && state.outputValidationAttempts < retries) {
        const limit = state.input.maxExchanges ?? DEFAULT_AGENT_MAX_EXCHANGES;
        if (state.exchanges >= limit) return { state, actions, next: { type: 'fail', error: {
            code: 'BUDGET_EXHAUSTED', message: `Invalid structured output: ${issue}; output repair requires another LLM exchange, but maxExchanges=${limit} is exhausted (${state.exchanges}/${limit})`,
        } } };

        state.outputValidationAttempts++;
        state.messages.push({
            role: 'user',
            content: outputRepairPrompt(state, issue),
        });
        return withActions(requestLlm(state), actions);
    }
    return {
        state,
        actions,
        next: { type: 'fail', error: { message: `Invalid structured output: ${issue}; output repair attempts exhausted (${state.outputValidationAttempts}/${retries}); exchanges=${state.exchanges}`, code: 'INVALID_OUTPUT' } },
    };
}

function outputRepairPrompt(state: DurableAgentState, issue: string): string {
    const format = state.input.responseFormat;
    const schema = format?.type === 'json_schema' ? JSON.stringify(format.json_schema.schema) : undefined;
    return `The previous response did not satisfy the required output contract: ${issue}.
Return only a complete valid JSON result, without Markdown fences or explanations.
Escape newlines, quotes and backslashes inside JSON strings. Do not truncate the result.
${schema ? `Return data matching this schema, not the schema itself: ${schema}` : 'Return a JSON object.'}`;
}

function outputValidationDiagnostic(state: DurableAgentState, value: ReturnType<typeof response>, issue: string): KernelAction {
    const content = value.choices[0]?.message.content;
    const text = typeof content === 'string' ? content : '';
    return { type: 'emit', eventType: 'llm.output.invalid', payload: {
        sessionId: state.input.sessionId, roundId: state.input.roundId, connectionId: state.input.connectionId,
        effectId: `llm-exchange-${state.exchanges}`, model: value.model ?? state.input.model ?? null,
        responseId: value.id ?? null, finishReason: value.choices[0]?.finish_reason ?? null,
        usage: value.usage ?? {}, issue, contentLength: text.length,
        contentHead: text.slice(0, 256), contentTail: text.length > 256 ? text.slice(-256) : '',
        repairAttempts: state.outputValidationAttempts, policy: state.input.outputValidation ?? {},
        maxExchanges: state.input.maxExchanges ?? DEFAULT_AGENT_MAX_EXCHANGES,
    } };
}

function outputValidationIssue(input: DurableAgentInput, content: unknown): string | undefined {
    const format = input.responseFormat;
    if (!format || format.type === 'text') return undefined;
    if (typeof content !== 'string') return 'response content must be text for structured output';
    let value: unknown;
    try { value = JSON.parse(content); }
    catch (error) { return `response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`; }
    if (format.type === 'json_object') {
        return isRecord(value) ? undefined : 'response must be a JSON object';
    }
    return validateSchemaValue(value, format.json_schema.schema, '$');
}

function validateSchemaValue(value: unknown, schema: Record<string, unknown> | boolean, path: string): string | undefined {
    if (schema === true) return undefined;
    if (schema === false) return `${path}: value is forbidden`;
    const type = schema.type;
    if (typeof type === 'string' && !matchesType(value, type)) return `${path} must be ${type}`;
    if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
        return `${path} is not one of the allowed values`;
    }
    if (typeof value === 'number' && (!Number.isFinite(value)
        || (typeof schema.minimum === 'number' && value < schema.minimum)
        || (typeof schema.maximum === 'number' && value > schema.maximum))) return `${path} is outside the numeric range`;
    if (isRecord(value)) return validateObjectValue(value, schema, path);
    if (Array.isArray(value) && (isRecord(schema.items) || typeof schema.items === 'boolean')) {
        for (let index = 0; index < value.length; index++) {
            const issue = validateSchemaValue(value[index], schema.items, `${path}[${index}]`);
            if (issue) return issue;
        }
    }
    return undefined;
}

function validateObjectValue(value: Record<string, unknown>, schema: Record<string, unknown>, path: string): string | undefined {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
        const declared = Object.hasOwn(properties, key);
        if (!declared && schema.additionalProperties === false) return `${path}.${key}: unexpected property`;
        const child = declared ? properties[key] : schema.additionalProperties;
        if (isRecord(child) || typeof child === 'boolean') {
            const issue = validateSchemaValue(item, child, `${path}.${key}`);
            if (issue) return issue;
        }
    }
    return undefined;
}

function matchesType(value: unknown, type: string): boolean {
    if (type === 'object') return isRecord(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'null') return value === null;
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

function initialState(input: DurableAgentInput): DurableAgentState {
    return {
        input: clone(input), phase: 'collecting',
        // Initial Skill selection and runtime loads share one activation path.
        skillContexts: input.skillContexts === undefined ? undefined : clone(input.skillContexts),
        messages: [], dependencyOutputs: {},
        resolvedDependencyIds: [],
        usage: {}, exchanges: 0, pendingCalls: [], callIndex: 0, approvedCallKeys: [], approvalProtocol: 2, pendingApprovalInteractionId: undefined, outputValidationAttempts: 0,
    };
}

function waitForInput(state: DurableAgentState): Decision<DurableAgentState, DurableAgentOutput>['next'] {
    if (!state.capabilities) return { type: 'wait', on: { type: 'signal', id: CAPABILITY_SIGNAL } };
    const bindings = state.input.dependencyBindings ?? [];
    return bindings.length ? dependencyWait(bindings) : { type: 'continue' };
}

function requiresApproval(state: DurableAgentState, call: ToolCall): boolean {
    if (state.input.approval === 'all') return true;
    if (state.input.approval !== 'external') return false;
    const external = new Set(state.input.externalToolIds ?? []);
    for (const tool of loadedTools(state)) {
        if (tool.external) external.add(tool.definition.function?.name ?? tool.definition.name ?? tool.toolId);
    }
    return external.has(toolName(call));
}

function isCallApproved(state: DurableAgentState, call: ToolCall): boolean {
    return (state.approvedCallKeys ?? []).includes(approvalKey(state, call));
}

function approvalInteractionId(state: DurableAgentState, call: ToolCall): string {
    return `approval:${state.exchanges}:${call.id}`;
}

function approvalKey(state: DurableAgentState, call: ToolCall): string {
    return JSON.stringify([state.input.roundId, state.exchanges, call.id, toolName(call), canonicalJson(toolArguments(call))]);
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
        : item);
}

function validateToolCalls(calls: ToolCall[]): string | undefined {
    const ids = new Set<string>();
    for (const call of calls) {
        const id = typeof call?.id === 'string' ? call.id.trim() : '';
        if (!id) return 'Tool call id is required';
        if (ids.has(id)) return `Duplicate tool call id: ${id}`;
        ids.add(id);
        if (!toolName(call).trim()) return 'Tool name is required';
    }
    return undefined;
}

function loadedTools(state: DurableAgentState) {
    const allowed = new Set(state.input.allowedToolIds ?? []);
    return (state.skillContexts ?? []).flatMap(skill => skill.tools ?? []).filter(tool => allowed.has(tool.toolId));
}

function effectiveTools(state: DurableAgentState) {
    const definitions = new Map((state.input.tools ?? []).map(tool => [tool.function?.name ?? tool.name, tool]));
    for (const tool of loadedTools(state)) {
        const name = tool.definition.function?.name ?? tool.definition.name;
        // The original node definitions take precedence over dynamic bindings.
        if (name && !definitions.has(name)) definitions.set(name, tool.definition);
    }
    return [...definitions.values()];
}

function appendRejected(state: DurableAgentState, reason: string): void {
    state.messages.push(...state.pendingCalls.slice(state.callIndex).map(call => ({
        role: 'tool' as const, tool_call_id: call.id, content: reason,
    })));
    state.pendingCalls = [];
    state.callIndex = 0;
    state.approvedCallKeys = [];
    state.approvalProtocol = 2;
    state.pendingApprovalInteractionId = undefined;
}

function appendHumanResponse(state: DurableAgentState, value: JsonValue): void {
    const human = state.pendingCalls.find(call => isHumanTool(toolName(call)));
    state.messages.push(...state.pendingCalls.map(call => ({
        role: 'tool' as const,
        tool_call_id: call.id,
        content: call.id === human?.id ? String(value ?? '') : 'Skipped while waiting for human input',
    })));
    state.pendingCalls = [];
    state.callIndex = 0;
    state.approvedCallKeys = [];
    state.approvalProtocol = 2;
    state.pendingApprovalInteractionId = undefined;
}

function isHumanTool(name: string): boolean {
    return name === 'human_input' || name === 'AskUserQuestion';
}

function withActions(
    decision: Decision<DurableAgentState, DurableAgentOutput>,
    prefix: KernelAction[],
): Decision<DurableAgentState, DurableAgentOutput> {
    return { ...decision, actions: [...prefix, ...(decision.actions ?? [])] };
}

function fail(
    state: DurableAgentState,
    message: string,
    code?: string,
): Decision<DurableAgentState, DurableAgentOutput> {
    return { state, next: { type: 'fail', error: { message, code } } };
}

function callInfo(call: ToolCall) { return { toolId: call.id, name: toolName(call), input: toolArguments(call) }; }
function clone<T>(value: T): T { return structuredClone(value); }
function jsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; }
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validate(input: DurableAgentInput): void {
    if (!input.sessionId || !input.roundId || !input.connectionId) {
        throw new Error('DurableAgentProgram requires sessionId, roundId and connectionId');
    }
    if (!input.messages.length) throw new Error('DurableAgentProgram requires messages');
}

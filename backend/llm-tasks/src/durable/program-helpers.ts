import type { AgentEvent } from '../contracts';
import type { ChatCompletionResponse, TokenUsage } from '@itookit/driver-llm/contracts';
import type { ChatMessage, ToolCall } from '@itookit/llm-context';
import { DEFAULT_EFFECT_TIMEOUT_MS, resolveLlmRetryPolicy, resolveToolTimeoutMs } from '../contracts';
import type {
    JsonValue,
    KernelAction,
    TaskInputEvent,
} from '@itookit/durable-kernel';
import type {
    DurableCapabilitySignal,
    DurableDependencyBinding,
    DurableProgramInput,
} from './types';

export const CAPABILITY_SIGNAL = 'capabilities';

export function capabilitySignal(event: TaskInputEvent): DurableCapabilitySignal | undefined {
    if (event.type !== 'signal' || event.signal.type !== CAPABILITY_SIGNAL) return undefined;
    const payload = record(event.signal.payload);
    if (typeof payload.llmHandleId !== 'string') throw new Error('LLM resource handle is required');
    return {
        llmHandleId: payload.llmHandleId,
        toolHandleId: typeof payload.toolHandleId === 'string' ? payload.toolHandleId : undefined,
    };
}

export function dependencyOutput(
    event: TaskInputEvent,
    bindings: DurableDependencyBinding[] = [],
    defaultOutput?: string,
): { taskId: string; key: string; value: JsonValue } | undefined {
    if (event.type !== 'task-exited') return undefined;
    const binding = bindings.find(item => item.taskId === event.taskId);
    if (!binding) return undefined;
    return { taskId: event.taskId, key: binding.input, value: extractNodeOutput(event.exit.output, binding.output ?? defaultOutput) };
}

/**
 * Resolve the value a node/task output contributes to a consumer.
 *
 * Canonical `outputs[output].content → message.content → raw` extraction shared by
 * llm-runtime (dependency edges), llm-conversation (FlowValueProgram) and apps/cli
 * (RunStore.selectFinalResult). Prefer the declared output artifact's content, then
 * an agent/chat `message.content`, then the raw output as a last resort — so edges
 * carry the upstream text result instead of the whole `{message, usage, ...}` envelope.
 */
export function extractNodeOutput(value: unknown, output?: string): JsonValue {
    const record = isRecord(value) ? value : {};
    const outputs = isRecord(record.outputs) ? record.outputs : {};
    if (output && isRecord(outputs[output])) {
        const artifact = outputs[output] as Record<string, unknown>;
        if ('content' in artifact) return jsonValue(artifact.content);
        return jsonValue(artifact);
    }
    if (isRecord(record.message) && 'content' in record.message) {
        return jsonValue(record.message.content);
    }
    return jsonValue(value);
}

export function mergeDependencyOutput(
    outputs: Record<string, JsonValue>,
    key: string,
    value: JsonValue,
): void {
    const current = outputs[key];
    outputs[key] = current === undefined
        ? value
        : Array.isArray(current) ? [...current, value] : [current, value];
}

export function llmEffect(
    input: DurableProgramInput,
    messages: ChatMessage[],
    handleId: string,
    tools?: import('@itookit/llm-context').ToolDefinition[],
    effectId?: string,
): KernelAction {
    const { retries, backoffMs } = resolveLlmRetryPolicy(input.llmRetry);
    const request = compact({
        _maxAttempts: 1,
        messages,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        thinking: input.thinking,
        reasoningEffort: input.reasoningEffort,
        webSearch: input.webSearch,
        responseFormat: input.responseFormat,
        tools,
        toolChoice: tools?.length ? 'auto' : 'none',
        // stream !== false → LLM adapter streams. false opts into non-streaming.
        stream: input.stream,
    });
    return {
        type: 'effect',
        effect: {
            id: effectId ?? `llm-${messages.length}`,
            kind: 'llm.chat',
            version: '1',
            request: { resourceHandleId: handleId, connectionId: input.connectionId, request },
            idempotencyKey: effectId ? `${input.roundId}:${effectId}` : `${input.roundId}:llm:${messages.length}`,
            timeoutMs: input.timeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS,
            retry: { maxAttempts: retries + 1, backoffMs },
            grants: [{ handleId, right: 'execute' }],
        },
    };
}

export function toolEffectId(exchange: number, call: ToolCall): string {
    return `tool-${exchange}-${call.id}`;
}

export function toolEffect(
    roundId: string,
    exchange: number,
    call: ToolCall,
    handleId: string,
    cwd?: string,
    timeoutMs?: number,
): KernelAction {
    return {
        type: 'effect',
        effect: {
            id: toolEffectId(exchange, call),
            kind: 'tool.call',
            version: '1',
            request: {
                resourceHandleId: handleId,
                callId: call.id,
                toolId: toolName(call),
                args: toolArguments(call),
                ...(cwd ? { cwd } : {}),
            },
            idempotencyKey: `${roundId}:${exchange}:tool:${call.id}`,
            timeoutMs: resolveToolTimeoutMs(timeoutMs),
            grants: [{ handleId, right: 'execute' }],
        },
    };
}

export function response(event: TaskInputEvent): ChatCompletionResponse {
    if (event.type !== 'effect-completed') throw new Error(`Expected LLM Effect, received ${event.type}`);
    const value = event.result as ChatCompletionResponse;
    if (!value?.choices?.[0]?.message) throw new Error('LLM Effect returned an invalid response');
    return value;
}

export function responseEvents(
    input: Pick<DurableProgramInput, 'sessionId' | 'roundId'>,
    round = 1,
): KernelAction[] {
    // Streaming content is emitted by the llm.chat effect itself during execution
    // (LlmChatEffectAdapter → context.emit → agent.event). Emitting the full content
    // here would double-render it in the UI, so only round:end is emitted.
    return [emit(roundEvent('round:end', input, round))];
}

export function emit(event: AgentEvent): KernelAction {
    return { type: 'emit', eventType: 'agent.event', payload: jsonValue(event) };
}

export function roundEvent(
    type: 'round:start' | 'round:end',
    input: Pick<DurableProgramInput, 'sessionId' | 'roundId'>,
    round = 1,
): AgentEvent {
    return { type, roundId: input.roundId, sessionId: input.sessionId, round };
}

export function assistantMessage(value: ChatCompletionResponse): ChatMessage {
    const message = value.choices[0].message;
    return { ...message, content: message.content ?? '' };
}

export function toolCalls(value: ChatCompletionResponse): ToolCall[] {
    return value.choices[0].message.tool_calls ?? [];
}

export function toolName(call: ToolCall): string {
    return call.function?.name ?? call.name ?? '';
}

export function toolArguments(call: ToolCall): Record<string, unknown> {
    try {
        return JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
    } catch {
        return {};
    }
}

export function addUsage(left: TokenUsage, right: TokenUsage = {}): TokenUsage {
    return {
        prompt_tokens: number(left.prompt_tokens) + number(right.prompt_tokens),
        completion_tokens: number(left.completion_tokens) + number(right.completion_tokens),
        total_tokens: number(left.total_tokens) + number(right.total_tokens),
    };
}

export function applyDependencyMessages(
    input: DurableProgramInput,
    outputs: Record<string, JsonValue>,
): ChatMessage[] {
    if (input.includeDependencyOutputs === false) return structuredClone(input.messages);
    if (!Object.keys(outputs).length) return structuredClone(input.messages);
    const content = Object.entries(outputs).map(([key, value]) => `${key}: ${stringify(value)}`).join('\n');
    return [...structuredClone(input.messages), { role: 'user', content }];
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function jsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function stringify(value: JsonValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function number(value: unknown): number { return typeof value === 'number' ? value : 0; }

import { assertModelConnection, type ModelConnectionSnapshot } from '../llm-management/contracts/model-requirements';
import { assertEffectGrant } from '@itookit/durable-kernel';
import type { LLMLogSink } from '@itookit/driver-llm/contracts';
import { silentAdapterLog } from '../ports/diagnostics';
import type { LlmCommunicationEvent } from '@itookit/driver-llm/contracts';
import type { AssistantMessage, ChatCompletionChunk, ChatCompletionParams, ChatCompletionResponse, Citation, FinishReason, TokenUsage } from '@itookit/driver-llm/contracts';
import type { ToolCall } from '@itookit/llm-context';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import type { EffectAdapter, EffectExecutionContext, EffectReconcileResult } from '@itookit/durable-kernel';
import { resolveCapability, type CapabilitySource } from '../ports/capabilities';
import { InFlightEffects } from './in-flight';
import type { KernelAdapterDiagnostics } from '../ports/diagnostics';


export interface LlmChatEffectRequest {
    connectionSnapshot?: ModelConnectionSnapshot;
    resourceHandleId: string;
    connectionId: string;
    request: Omit<ChatCompletionParams, 'signal'>;
    recovery?: 'retry' | 'indeterminate';
}

export class LlmChatEffectAdapter implements EffectAdapter<LlmChatEffectRequest, ChatCompletionResponse> {
    readonly kind = 'llm.chat';
    readonly version = '1';
    /** In-flight executions by Effect id, so `cancel` can confirm the request settled. */
    private readonly inFlight = new InFlightEffects();

    constructor(private readonly service: CapabilitySource<ILLMService>, private readonly log: LLMLogSink = silentAdapterLog,
        private readonly authorize?: KernelAdapterDiagnostics['authorizeLlm']) {}

    async execute(
        request: LlmChatEffectRequest,
        context: EffectExecutionContext,
    ): Promise<ChatCompletionResponse> {
        return this.inFlight.track(context, this.run(request, context));
    }

    /**
     * The Kernel aborts the Effect signal before calling `cancel`, and every provider
     * passes that signal into `fetch`. Waiting for the recorded execution turns
     * cancellation into a confirmation instead of an assumption.
     */
    async cancel(_request: LlmChatEffectRequest, context: EffectExecutionContext): Promise<void> {
        await this.inFlight.confirmStopped(context);
    }

    private async run(
        request: LlmChatEffectRequest,
        context: EffectExecutionContext,
    ): Promise<ChatCompletionResponse> {
        assertEffectGrant(context, request.resourceHandleId, 'llm');
        if (!request.connectionId.trim()) throw new Error('LLM connection id is required');
        const service = await resolveCapability(this.service, context);
        const controller = new AbortController();
        const abort = () => controller.abort(context.abortSignal.reason);
        if (context.abortSignal.aborted) abort();
        context.abortSignal.addEventListener('abort', abort, { once: true });
        const emit = makeEmitter(context, controller);
        try {
            await this.authorize?.(request, context);
            await assertFrozenConnection(service, request);
            await emit({ type: 'llm:request', effectId: context.effectId, connectionId: request.connectionId, request: request.request });
            await this.authorize?.(request, context);
            await assertFrozenConnection(service, request);
            context.abortSignal.throwIfAborted();
            const params: ChatCompletionParams = { ...request.request, signal: controller.signal };
            const response = request.request.stream === false
                ? await completeChat(service, request.connectionId, params, emit)
                : await streamChat(service, request.connectionId, params, emit);
            this.log.debug('LLM response assembled', {
                sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId,
                connectionId: request.connectionId, responseId: response.id, model: response.model,
                stream: request.request.stream !== false, responseFormat: request.request.responseFormat?.type,
                finishReason: response.choices[0]?.finish_reason,
                contentLength: response.choices[0]?.message.content?.length ?? 0, usage: response.usage,
            });
            await chargeUsage(context, request.resourceHandleId, response.usage);
            return response;
        } finally { context.abortSignal.removeEventListener('abort', abort); }
    }

    shouldRetry(error: unknown, context: EffectExecutionContext): boolean {
        if (context.abortSignal.aborted) return false;
        const failure = error as { name?: string; code?: string; retryable?: boolean; status?: number; message?: string };
        if (failure?.name === 'AbortError' || /\b(?:stale|lease|grant|permission|unauthorized|forbidden)\b|connection id/i.test(failure?.message ?? '')) return false;
        if (typeof failure?.retryable === 'boolean') return failure.retryable;
        if (typeof failure?.status === 'number') return failure.status === 408 || failure.status === 429 || failure.status >= 500;
        return /network|fetch failed|timeout|timed out|connection reset|ECONNRESET|ETIMEDOUT|rate limit|overload/i.test(failure?.message ?? '');
    }

    async reconcile(request: LlmChatEffectRequest): Promise<EffectReconcileResult<ChatCompletionResponse>> {
        if (request.recovery === 'retry') return { status: 'retry' };
        return {
            status: 'indeterminate',
            error: { message: 'LLM request outcome cannot be reconciled after worker loss', code: 'LLM_INDETERMINATE' },
        };
    }
}

export async function assertFrozenConnection(service: ILLMService, request: LlmChatEffectRequest): Promise<void> {
    const saved = request.connectionSnapshot;
    if (!saved) return;
    const connection = await service.getConnection(request.connectionId);
    if (!connection || connection.providerId !== saved.providerId || connection.protocol !== saved.protocol
        || request.request.model !== saved.modelId) throw new Error('Model connection changed after admission');
    assertModelConnection(connection, await service.getProvider(connection.providerId), saved.modelId, saved.requirements);
}

// ─── Streaming helpers ─────────────────────────────────────────────────────────

/** 流式事件批量窗口（ms）。合并 LLM 高频 chunk 为低频事件写入，缓解事件日志 O(n²) 轮询。 */
const STREAM_BATCH_MS = 40;

function makeEmitter(context: EffectExecutionContext, controller: AbortController): (event: LlmCommunicationEvent) => Promise<void> {
    const emit = context.emit;
    return async (event: LlmCommunicationEvent): Promise<void> => {
        try { await emit?.({ type: 'agent.event', payload: event }); }
        catch (error) { controller.abort(error); throw error; }
    };
}

/** 非流式（stream=false）：一次性把完整 thinking/content 写入事件日志，渲染统一归 effect 层。 */
async function completeChat(
    service: ILLMService,
    connectionId: string,
    params: ChatCompletionParams,
    emit: (event: LlmCommunicationEvent) => Promise<void>,
): Promise<ChatCompletionResponse> {
    const response = await service.chat(connectionId, params);
    await emitFinalContent(emit, response);
    return response;
}

/** 按 token 用量扣减 resource 预算；超出时由 kernel 抛错使 effect 失败。 */
async function chargeUsage(
    context: EffectExecutionContext,
    handleId: string,
    usage: TokenUsage | undefined,
): Promise<void> {
    const tokens = usage?.total_tokens
        ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0));
    if (typeof tokens !== 'number' || tokens <= 0) return;
    await context.chargeBudget?.(handleId, 'tokens', tokens);
}

async function emitFinalContent(
    emit: (event: LlmCommunicationEvent) => Promise<void>,
    response: ChatCompletionResponse,
): Promise<void> {
    const message = response.choices[0]?.message;
    if (message?.thinking) await emit({ type: 'stream:thinking', delta: message.thinking });
    if (message?.content) await emit({ type: 'stream:content', delta: message.content });
    if (response.citations?.length) await emit({ type: 'citations', citations: response.citations });
}

async function streamChat(
    service: ILLMService,
    connectionId: string,
    params: ChatCompletionParams,
    emit: (event: LlmCommunicationEvent) => Promise<void>,
): Promise<ChatCompletionResponse> {
    const batcher = new DeltaBatcher(emit);
    const aggregator = new ResponseAggregator();
    try {
        for await (const chunk of service.chatStream(connectionId, params)) {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.thinking) {
                aggregator.appendThinking(delta.thinking);
                batcher.push('stream:thinking', delta.thinking);
            }
            if (delta?.content) {
                aggregator.appendContent(delta.content);
                batcher.push('stream:content', delta.content);
            }
            if (delta?.tool_calls) aggregator.appendToolCalls(delta.tool_calls);
            aggregator.observe(chunk);
        }
        await batcher.flush();
        const response = aggregator.build();
        if (response.citations?.length) await emit({ type: 'citations', citations: response.citations });
        return response;
    } catch (error) {
        // Flush partial output so the UI shows what was generated before abort/failure.
        await batcher.flush();
        throw error;
    }
}

class DeltaBatcher {
    private pending: Array<{ type: 'stream:thinking' | 'stream:content'; delta: string }> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** 串行化 flush：并发 flush 会让增量 emit 交错、下游顺序错乱（内容被"洗牌"）。 */
    private chain: Promise<void> = Promise.resolve();
    private failure?: { error: unknown };

    constructor(private readonly emit: (event: LlmCommunicationEvent) => Promise<void>) {}

    push(type: 'stream:thinking' | 'stream:content', delta: string): void {
        if (this.failure) throw this.failure.error;
        this.pending.push({ type, delta });
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush().catch(() => { /* The stored failure is propagated by push/flush. */ });
        }, STREAM_BATCH_MS);
    }

    private throwIfFailed(): void { if (this.failure) throw this.failure.error; }

    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.failure) { this.pending = []; throw this.failure.error; }
        const batch = mergeConsecutive(this.pending);
        this.pending = [];
        if (batch.length === 0) { await this.chain; this.throwIfFailed(); return; }
        // 每个批次串到前一批之后，保证 emit 顺序与增量到达顺序一致。
        const next = this.chain.then(async () => {
            if (this.failure) throw this.failure.error;
            for (const item of batch) {
                await this.emit({ type: item.type, delta: item.delta });
            }
        });
        this.chain = next.catch(error => { this.failure ??= { error }; });
        return next;
    }
}

/**
 * Collapse runs of same-type deltas into one delta.
 *
 * Every provider chunk would otherwise become its own journal event (hundreds per
 * response), bloating task storage and the transcript view. Only *consecutive*
 * same-type deltas are merged, so thinking/content interleaving stays ordered.
 */
function mergeConsecutive(
    batch: Array<{ type: 'stream:thinking' | 'stream:content'; delta: string }>,
): Array<{ type: 'stream:thinking' | 'stream:content'; delta: string }> {
    const merged: Array<{ type: 'stream:thinking' | 'stream:content'; delta: string }> = [];
    for (const item of batch) {
        const last = merged[merged.length - 1];
        if (last && last.type === item.type) last.delta += item.delta;
        else merged.push({ ...item });
    }
    return merged;
}

class ResponseAggregator {
    private content = '';
    private thinking = '';
    private citations?: Citation[];
    private readonly toolCallByIndex = new Map<number, ToolCall>();
    private usage?: TokenUsage;
    private finishFromUsage: FinishReason = null;
    private lastFinishReason: FinishReason = null;
    private id?: string;
    private model?: string;

    appendContent(delta: string): void { this.content += delta; }
    appendThinking(delta: string): void { this.thinking += delta; }

    appendToolCalls(calls: ChatCompletionChunk['choices'][number]['delta']['tool_calls']): void {
        for (const call of calls ?? []) {
            const index = call.index ?? 0;
            let entry = this.toolCallByIndex.get(index);
            if (!entry) {
                entry = { id: call.id ?? '', type: (call.type as ToolCall['type']) ?? 'function', function: { name: '', arguments: '' } };
                this.toolCallByIndex.set(index, entry);
            }
            if (call.id) entry.id = call.id;
            const fn = entry.function ?? { name: '', arguments: '' };
            if (call.function?.name) fn.name += call.function.name;
            if (call.function?.arguments) fn.arguments += call.function.arguments;
            entry.function = fn;
        }
    }

    observe(chunk: ChatCompletionChunk): void {
        if (!this.id && chunk.id) this.id = chunk.id;
        if (!this.model && chunk.model) this.model = chunk.model;
        if (chunk.usage) this.usage = chunk.usage;
        if (chunk.citations?.length) this.citations = chunk.citations;
        const reason = chunk.choices?.[0]?.finish_reason;
        if (!reason) return;
        // Anthropic: message_delta carries the real finish_reason + usage; message_stop
        // appends a synthetic 'stop' that would mask 'tool_use'. Trust the usage chunk.
        if (chunk.usage) this.finishFromUsage = reason;
        this.lastFinishReason = reason;
    }

    build(): ChatCompletionResponse {
        const toolCalls = this.toolCallByIndex.size
            ? Array.from(this.toolCallByIndex.values())
            : undefined;
        const message: AssistantMessage = {
            role: 'assistant',
            content: this.content || '',
            ...(this.thinking ? { thinking: this.thinking } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
        };
        return {
            ...(this.id ? { id: this.id } : {}),
            ...(this.model ? { model: this.model } : {}),
            choices: [{
                index: 0,
                message,
                finish_reason: this.finishFromUsage ?? this.lastFinishReason,
            }],
            ...(this.usage ? { usage: this.usage } : {}),
            ...(this.citations?.length ? { citations: this.citations } : {}),
        };
    }
}

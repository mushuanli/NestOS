import { describe, expect, it, vi } from 'vitest';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { LlmChatEffectAdapter } from './llm-chat-effect';

describe('LlmChatEffectAdapter streaming', () => {
    it('checks host policy before storing a request and again immediately before provider dispatch', async () => {
        const emit = vi.fn(async () => undefined), chat = vi.fn();
        const authorize = vi.fn(async () => { throw new Error('permission revoked'); });
        const request = { resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [], stream: false } };
        await expect(new LlmChatEffectAdapter({ chat } as unknown as ILLMService, undefined, authorize)
            .execute(request, context(emit))).rejects.toThrow('permission revoked');
        expect(emit).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled();
        authorize.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('permission changed while storing'));
        await expect(new LlmChatEffectAdapter({ chat } as unknown as ILLMService, undefined, authorize)
            .execute(request, context(emit))).rejects.toThrow('permission changed while storing');
        expect(emit).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledTimes(2); expect(chat).not.toHaveBeenCalled();
    });

    it('aggregates streamed chunks into a full response and emits deltas', async () => {
        const emit = vi.fn(async () => undefined);
        const service = streamService(async function* () {
            yield { id: 'm1', model: 'gpt-x', choices: [{ index: 0, delta: { thinking: 'Hmm ' }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] };
            yield { id: 'm1', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { total_tokens: 7 } };
        });
        const adapter = new LlmChatEffectAdapter(service);

        const response = await adapter.execute({
            resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [] },
        }, context(emit));

        expect(response.choices[0].message.content).toBe('Hello world');
        expect(response.choices[0].message.thinking).toBe('Hmm ');
        expect(response.choices[0].finish_reason).toBe('stop');
        expect(response.usage).toEqual({ total_tokens: 7 });
        expect(response.model).toBe('gpt-x');

        const emitted = emit.mock.calls.map(([event]) => (event as { payload: unknown }).payload);
        expect(emitted).toContainEqual({ type: 'stream:thinking', delta: 'Hmm ' });
        // Consecutive content deltas in one batch collapse into a single event so the
        // journal does not grow by one entry per provider chunk.
        expect(emitted).toContainEqual({ type: 'stream:content', delta: 'Hello world' });
    });

    it('propagates a timed persistence failure and aborts the provider without an unhandled rejection', async () => {
        const failure = new Error('Stale effect claim');
        let providerSignal: AbortSignal | undefined;
        const emit = vi.fn(async (event: any) => {
            if (event.payload.type === 'stream:content') throw failure;
        });
        const service = streamService(async function* (_connection, params) {
            providerSignal = params.signal;
            yield { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] };
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(resolve, 1000);
                params.signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(params.signal?.reason); }, { once: true });
            });
        });
        await expect(new LlmChatEffectAdapter(service).execute({ resourceHandleId: 'llm-handle',
            connectionId: 'conn', request: { messages: [] } }, context(emit))).rejects.toBe(failure);
        expect(providerSignal?.aborted).toBe(true);
        expect(emit.mock.calls.filter(([event]) => event.payload.type === 'stream:content')).toHaveLength(1);
    });

    it.each([
        [Object.assign(new Error('temporary'), { retryable: true }), true],
        [new Error('fetch failed'), true], [new Error('request timed out'), true],
        [new Error('Service overloaded; please retry later'), true],
        [Object.assign(new Error('Please retry later'), { retryable: true }), true],
        [Object.assign(new Error('bad credentials'), { retryable: false }), false],
        [new Error('Stale effect claim'), false], [new Error('Effect lease lost'), false],
        [Object.assign(new Error('aborted'), { name: 'AbortError' }), false],
        [new Error('invalid configuration'), false],
    ])('classifies live LLM failures without relaxing crash recovery: %s', async (error, expected) => {
        const adapter = new LlmChatEffectAdapter({} as ILLMService);
        expect(adapter.shouldRetry(error, context(undefined))).toBe(expected);
        await expect(adapter.reconcile({ resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [] } }))
            .resolves.toMatchObject({ status: 'indeterminate' });
    });

    it('keeps interleaved thinking and content deltas ordered', async () => {
        const emit = vi.fn(async () => undefined);
        const service = streamService(async function* () {
            yield { choices: [{ index: 0, delta: { thinking: 'a' }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { thinking: 'c' }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { content: 'd' }, finish_reason: 'stop' }] };
        });
        const adapter = new LlmChatEffectAdapter(service);

        await adapter.execute({
            resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [] },
        }, context(emit));

        const emitted = emit.mock.calls.map(([event]) => (event as { payload: unknown }).payload);
        expect(emitted[0]).toMatchObject({ type: 'llm:request', connectionId: 'conn', request: { messages: [] } });
        expect(emitted.slice(1)).toEqual([
            { type: 'stream:thinking', delta: 'a' },
            { type: 'stream:content', delta: 'b' },
            { type: 'stream:thinking', delta: 'c' },
            { type: 'stream:content', delta: 'd' },
        ]);
    });

    it('merges tool_calls by index and keeps the real tool_use finish reason', async () => {
        const emit = vi.fn(async () => undefined);
        const service = streamService(async function* () {
            yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'echo', arguments: '' } }] }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: null }] };
            yield { choices: [{ index: 0, delta: {}, finish_reason: 'tool_use' }], usage: { total_tokens: 3 } };
            yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        });
        const adapter = new LlmChatEffectAdapter(service);

        const response = await adapter.execute({
            resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [] },
        }, context(emit));

        const calls = response.choices[0].message.tool_calls!;
        expect(calls).toHaveLength(1);
        expect(calls[0].id).toBe('call-1');
        expect(calls[0].function?.name).toBe('echo');
        expect(calls[0].function?.arguments).toBe('{"a":1}');
        expect(response.choices[0].finish_reason).toBe('tool_use');
    });

    it('emits final content once for non-streaming requests', async () => {
        const emit = vi.fn(async () => undefined);
        const service = {
            chat: async () => ({
                choices: [{ index: 0, message: { role: 'assistant' as const, content: 'full', thinking: 't' }, finish_reason: 'stop' }],
            }),
            chatStream: async () => { throw new Error('should not stream'); },
        } as ILLMService;
        const adapter = new LlmChatEffectAdapter(service);

        const response = await adapter.execute({
            resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [], stream: false },
        }, context(emit));

        expect(response.choices[0].message.content).toBe('full');
        const emitted = emit.mock.calls.map(([event]) => (event as { payload: unknown }).payload);
        expect(emitted).toContainEqual({ type: 'stream:thinking', delta: 't' });
        expect(emitted).toContainEqual({ type: 'stream:content', delta: 'full' });
    });
});

describe('LlmChatEffectAdapter cancellation', () => {
    it('confirms cancellation only after the in-flight request has settled', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const controller = new AbortController();
        const service = streamService(async function* () {
            await blocked;
            if (controller.signal.aborted) throw new Error('aborted');
            yield { choices: [{ index: 0, delta: { content: 'late' }, finish_reason: 'stop' }] };
        });
        const adapter = new LlmChatEffectAdapter(service);
        const request = { resourceHandleId: 'llm-handle', connectionId: 'conn', request: { messages: [] } };
        const execution = adapter.execute(request, { ...context(vi.fn(async () => undefined)), abortSignal: controller.signal });

        let cancelled = false;
        const cancellation = adapter.cancel(request, { ...context(vi.fn(async () => undefined)), abortSignal: controller.signal })
            .then(() => { cancelled = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        // The adapter must not report "stopped" while the request is still in flight.
        expect(cancelled).toBe(false);

        controller.abort();
        release();
        await expect(execution).rejects.toThrow('aborted');
        await cancellation;
        expect(cancelled).toBe(true);
    });
});

function streamService(chatStream: ILLMService['chatStream']): ILLMService {
    return {
        chat: async () => { throw new Error('should not call chat'); },
        chatStream,
        abort: () => undefined,
        getConnection: async () => undefined,
        getDefaultConnection: async () => null,
        listConnections: async () => [],
        getProvider: async () => undefined,
        estimateTokens: () => 0,
    } as ILLMService;
}

function context(emit: EffectExecutionContext['emit']): EffectExecutionContext {
    return {
        sessionId: 'session-a', taskId: 'task-a', effectId: 'effect-a',
        abortSignal: new AbortController().signal,
        grants: [{
            handleId: 'llm-handle', right: 'execute',
            resource: {
                id: 'llm-resource', sessionId: 'session-a', kind: 'llm', uri: 'llm://pending',
                generation: 1, createdAt: Date.now(),
            },
        }],
        emit,
    };
}

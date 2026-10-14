import { expect, it } from 'vitest';
import { createContextEngine, measureContext } from './engine';
import { createContextContentStore } from '../content/store';
import { createContextService } from '../application/service';
import type { ContextEngineOptions } from '../domain/durable';

function service(options: ContextEngineOptions) {
    const blobs = new Map<string, string>();
    const content = createContextContentStore({ get: async id => blobs.get(id) ?? null,
        putIfAbsent: async (id, text) => { blobs.set(id, text); } });
    return { content, context: createContextService({ content, records: { get: async () => undefined }, engineOptions: options }) };
}

it('uses injected request accounting for selection and durable explanations', async () => {
    const requests: Record<string, unknown>[] = [];
    const counter = (request: Record<string, unknown>) => { requests.push(request); return 5; };
    const { context } = service({ estimateTokens: counter, estimated: false, defaultPolicy: { maxMessages: 10, maxInputTokens: 6 } });
    const result = await context.prepare({ contextId: 'task', operationId: 'first',
        request: { tools: [{ name: 'custom-tool' }] }, messages: [{ role: 'user', content: 'large '.repeat(100) }] });
    expect(result.explanation.inputTokens).toBe(5);
    expect(result.explanation.estimated).toBe(false);
    expect(requests.every(request => Array.isArray(request.tools))).toBe(true);
});

it('checks checkpoint notes with the same injected counter and budget', async () => {
    const { context, content } = service({ defaultPolicy: { maxMessages: 10, maxInputTokens: 5 },
        estimateTokens: request => (request.messages as Array<{ tags?: string[] }>).some(message => message.tags?.includes('context-notes')) ? 6 : 1 });
    const evidence = await content.publish('evidence');
    await expect(context.prepare({ contextId: 'task', operationId: 'checkpoint', request: {}, messages: [{ role: 'user', content: 'goal' }],
        notes: { revision: 1, basedOnRevision: 0, text: 'notes', evidence: [evidence] } }))
        .rejects.toThrow('Checkpoint notes exceed');
});

it('rejects invalid counters and preserves a custom engine method receiver', () => {
    for (const count of [-1, NaN, Infinity, 0.5]) {
        expect(() => createContextEngine({ estimateTokens: () => count }).select([{ role: 'user', content: 'goal' }], {}))
            .toThrow('Token counter returned an invalid count');
    }
    const engine = { limit: 7, select: createContextEngine().select,
        measure() { return { inputTokens: this.limit, maxInputTokens: 10, estimated: false }; } };
    expect(measureContext(engine, {}).inputTokens).toBe(7);
});

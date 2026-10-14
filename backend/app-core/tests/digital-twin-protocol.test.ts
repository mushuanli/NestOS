import { expect, it, vi } from 'vitest';
import type { Kernel } from '@itookit/durable-kernel';
import type { TwinAnalysisJob } from '../src/digital-twin/domain';
import { KernelTwinExtractor, parseCandidates } from '../src/digital-twin/extraction';
import { diagnosticDetail } from '../src/digital-twin/diagnostics';

const job = { sessionId: 'session', connectionId: 'connection', reservedTokens: 1000 } as TwinAnalysisJob;
it('sends bounded extraction with thinking disabled through the kernel input', async () => {
    const submit = vi.fn(async (_request: unknown) => ({ id: 'task', status: async () => ({ task: { status: 'succeeded' } }),
        wait: async () => ({ status: 'succeeded', output: { finishReason: 'stop', usage: { total_tokens: 100 },
            message: { content: '{"candidates":[]}' } } }) }));
    const kernel = { openSession: async () => ({ submit }) } as unknown as Kernel;
    await expect(new KernelTwinExtractor(kernel).run(job, 'source', async () => {})).resolves.toEqual({ candidates: [], tokens: 100 });
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ input: { thinking: false, maxTokens: 8192, stream: false } });
    expect((submit.mock.calls[0]?.[0] as any).input.responseFormat).toBeUndefined();
});
it('rejects output truncation even when the partial output is valid JSON', async () => {
    const kernel = { openSession: async () => ({ submit: async () => ({ id: 'task',
        status: async () => ({ task: { status: 'succeeded' } }), wait: async () => ({ status: 'succeeded',
            output: { finishReason: 'length', usage: { total_tokens: 100 }, message: { content: '{"candidates":[]}' } } }) }) }) } as unknown as Kernel;
    await expect(new KernelTwinExtractor(kernel).run(job, 'source', async () => {})).rejects.toThrow('TWIN_EXTRACTION_TRUNCATED');
});
it('reports the failed evidence check without exposing private text', () => {
    const candidate = { content: 'private content', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'private quote' };
    let failure: unknown;
    try { parseCandidates(JSON.stringify({ candidates: [candidate] }), 'source'); } catch (error) { failure = error; }
    expect(diagnosticDetail(failure)).toContain('Candidate 0: Quote does not exactly match the source');
    expect(diagnosticDetail(failure)).not.toContain('private');
});

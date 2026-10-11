import { expect, it, vi } from 'vitest';
import type { Kernel } from '@itookit/durable-kernel';
import { KernelTwinExtractor, parseCandidates } from '../src/digital-twin/extraction';
import { diagnosticDetail, TwinDiagnosticError } from '../src/digital-twin/diagnostics';
import type { TwinAnalysisJob } from '../src/digital-twin/domain';

function extractor(exit: unknown, waitError?: Error) {
    const task = { id: 'task', status: async () => ({ task: { status: 'failed' } }),
        wait: vi.fn(async () => { if (waitError) throw waitError; return exit; }) };
    const kernel = { openSession: async () => ({ submit: async () => task }) } as unknown as Kernel;
    return new KernelTwinExtractor(kernel);
}
const job = { sessionId: 'session', connectionId: 'connection', reservedTokens: 1000 } as TwinAnalysisJob;
it('preserves an actionable task failure without credentials', async () => {
    const run = extractor({ status: 'failed', error: { code: 'HTTP_401',
        message: 'Authentication failed apiKey=secret-value Bearer hidden-value https://host/?api_key=another-secret' } });
    const error = await run.run(job, 'source', async () => {}).catch(error => error);
    expect(error.message).toBe('TWIN_EXTRACTION_FAILED');
    expect(error.detail).toContain('HTTP_401');
    expect(error.detail).toContain('Authentication failed');
    expect(error.detail).not.toMatch(/secret-value|hidden-value|another-secret/);
});
it('distinguishes timeout, cancellation and output truncation', async () => {
    await expect(extractor(null, new Error('Task wait timed out: task')).run(job, 'source', async () => {})).rejects.toThrow('TWIN_EXTRACTION_TIMEOUT');
    await expect(extractor({ status: 'cancelled' }).run(job, 'source', async () => {})).rejects.toThrow('TWIN_EXTRACTION_CANCELLED');
    await expect(extractor({ status: 'failed', error: { message: 'Request timed out after 60000 ms without a response' } }).run(job, 'source', async () => {})).rejects.toThrow('TWIN_EXTRACTION_TIMEOUT');
    await expect(extractor({ status: 'succeeded', output: { finishReason: 'length' } }).run(job, 'source', async () => {})).rejects.toThrow('TWIN_EXTRACTION_TRUNCATED');
});
it('reports malformed JSON as invalid extraction without storing the model response', () => {
    expect(() => parseCandidates('private malformed output', 'source')).toThrow('TWIN_INVALID_EXTRACTION');
    expect(() => parseCandidates('null', 'source')).toThrow('TWIN_INVALID_EXTRACTION');
    expect(diagnosticDetail(new TwinDiagnosticError('TWIN_INVALID_EXTRACTION', { message: 'Model returned invalid JSON' }))).toBe('Model returned invalid JSON');
});

it('logs stages, time and safe diagnostic fields without source text', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        await extractor({ status: 'failed', error: { message: 'Network connection failed' } }).run(job, 'private source text', async () => {}).catch(() => {});
        const events = [...log.mock.calls, ...warn.mock.calls].map(call => call[1]);
        expect(events.some(event => event.stage === 'submitted' && event.taskId === 'task')).toBe(true);
        expect(events.some(event => event.stage === 'failed' && event.failedStage === 'waiting' && event.errorDetail.includes('Network connection failed'))).toBe(true);
        expect(events.every(event => event.time && event.connectionId === 'connection')).toBe(true);
        expect(JSON.stringify(events)).not.toContain('private source text');
    } finally { log.mockRestore(); warn.mockRestore(); }
});
it('normalizes a thrown string with its execution stage instead of losing the message', async () => {
    const kernel = { openSession: async () => { throw 'Connection not configured'; } } as unknown as Kernel;
    const error = await new KernelTwinExtractor(kernel).run(job, 'source', async () => {}).catch(error => error);
    expect(error.message).toBe('TWIN_EXTRACTION_FAILED');
    expect(error.detail).toContain('submitting: Connection not configured');
});

it('retains known provider usage for truncated or malformed output', async () => {
    const truncated = await extractor({ status: 'succeeded', output: { finishReason: 'length', usage: { total_tokens: 1234 } } }).run(job, 'source', async () => {}).catch(error => error);
    expect(truncated.message).toBe('TWIN_EXTRACTION_TRUNCATED');
    expect(truncated.tokens).toBe(1234);
    const malformed = await extractor({ status: 'succeeded', output: { finishReason: 'stop', usage: { total_tokens: 2345 },
        message: { content: 'invalid JSON' } } }).run(job, 'source', async () => {}).catch(error => error);
    expect(malformed.message).toBe('TWIN_INVALID_EXTRACTION');
    expect(malformed.tokens).toBe(2345);
});

it('submits bounded extraction with thinking disabled and validates prompt-based JSON', async () => {
    const submit = vi.fn(async (_request: unknown) => ({ id: 'task', status: async () => ({ task: { status: 'succeeded' } }),
        wait: async () => ({ status: 'succeeded', output: { finishReason: 'stop', usage: { total_tokens: 100 },
            message: { content: '{"candidates":[]}' } } }) }));
    const kernel = { openSession: async () => ({ submit }) } as unknown as Kernel;
    await expect(new KernelTwinExtractor(kernel).run(job, 'source', async () => {})).resolves.toEqual({ candidates: [], tokens: 100 });
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ input: { thinking: false, maxTokens: 8192, stream: false } });
    expect((submit.mock.calls[0]?.[0] as any).input.responseFormat).toBeUndefined();
});

it('identifies invalid candidate fields without including private model text', () => {
    const candidate = { content: 'private content', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'private unsupported quote' };
    const error = (() => { try { parseCandidates(JSON.stringify({ candidates: [candidate] }), 'source'); } catch (error) { return error; } })();
    expect(error).toBeInstanceOf(TwinDiagnosticError);
    expect(diagnosticDetail(error)).toContain('Candidate 0: Quote does not exactly match the source');
    expect(diagnosticDetail(error)).not.toContain('private');
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ ...candidate, quote: 'source', project: null }] }), 'source'))
        .toThrow('TWIN_INVALID_EXTRACTION');
});

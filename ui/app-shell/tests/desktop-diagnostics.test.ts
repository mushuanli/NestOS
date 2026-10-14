// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { observeTools, recordDiagnostic } from '../../../apps/tauri-app/src/log/desktop-diagnostics';

afterEach(() => vi.unstubAllGlobals());
function capture() {
    const invoke = vi.fn(async (_command: string, _args: { event: string; message: string }, _options?: unknown) => undefined);
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    return invoke;
}

it('persists bounded frontend errors without failing on circular rejection values', async () => {
    const invoke = capture();
    await recordDiagnostic('test.error', new Error('failed'));
    expect(invoke).toHaveBeenCalledWith('diagnostic_event', expect.objectContaining({ event: 'test.error', message: expect.stringContaining('failed') }), undefined);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await recordDiagnostic('rejection', circular);
    window.dispatchEvent(new ErrorEvent('error', { message: 'window failed' }));
    expect(invoke).toHaveBeenLastCalledWith('diagnostic_event', { event: 'error', message: 'window failed' }, undefined);
    await recordDiagnostic('long', '中'.repeat(10_000));
    expect(new TextEncoder().encode(invoke.mock.calls.at(-1)?.[1]?.message).length).toBeLessThanOrEqual(16_384);
});

it('logs the actual scope and lifecycle without consuming the UI progress callback', async () => {
    const invoke = capture(), progress = vi.fn(async () => {});
    const result = { toolId: 'Grep', success: true, output: 'private file contents', durationMs: 1 };
    const service = { invoke: vi.fn(async request => { await request.onProgress({ message: 'cwd: /workspace' }); return result; }) };
    observeTools(service as never, 'session-1');
    expect(await service.invoke({ toolId: 'Grep', args: { pattern: 'mdx' }, onProgress: progress })).toBe(result);
    expect(progress).toHaveBeenCalledWith({ message: 'cwd: /workspace' });
    expect(invoke.mock.calls.map(call => (call as any)[1].event)).toEqual(['tool.running', 'tool.progress', 'tool.success']);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('private file contents');
});

it('keeps source names and nested AggregateError causes in the persisted failure', async () => {
    const invoke = capture();
    const database = new Error('database is locked');
    const source = new Error('root database=/data/_meta/index.db', { cause: database });
    const failure = new AggregateError([source, new Error('cleanup failed')], 'Filesystem sources could not be opened');
    await recordDiagnostic('bootstrap.failed', failure);
    const message = invoke.mock.calls.at(-1)![1].message;
    expect(message).toContain('/data/_meta/index.db');
    expect(message).toContain('database is locked');
    expect(message).toContain('cleanup failed');
    (database as Error & { cause: unknown }).cause = failure;
    await expect(recordDiagnostic('cyclic', failure)).resolves.toBeUndefined();
});

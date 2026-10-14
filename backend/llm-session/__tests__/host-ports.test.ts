import { expect, it, vi } from 'vitest';
import { createSessionHost } from '../src/utils/host-ports';
import { SessionEventBus } from '../src/session/session-event-bus';
import { assertExecutionMode } from '../src/session/execution-mode-policy';

it('isolates translation and listener diagnostics between concurrent instances', () => {
    const first = createSessionHost({ translate: key => `first:${key}`,
        logger: { debug() {}, info() {}, warn() {}, error: vi.fn() } });
    const second = createSessionHost({ translate: key => `second:${key}`,
        logger: { debug() {}, info() {}, warn() {}, error: vi.fn() } });
    const left = new SessionEventBus(first), right = new SessionEventBus(second);
    for (const bus of [left, right]) bus.onSession('same', () => { throw new Error('listener'); });
    left.emitSession('same', { type: 'error', error: { message: 'left' } });
    expect(first.logger.error).toHaveBeenCalledOnce();
    expect(second.logger.error).not.toHaveBeenCalled();
    right.emitSession('same', { type: 'error', error: { message: 'right' } });
    expect(second.logger.error).toHaveBeenCalledOnce();
    const locked = { executionMode: 'agent' as const, executionModeLocked: true };
    expect(() => assertExecutionMode(locked, 'chat', first.translate)).toThrow('first:chatInput.executionMode.locked');
    expect(() => assertExecutionMode(locked, 'chat', second.translate)).toThrow('second:chatInput.executionMode.locked');
    expect(() => assertExecutionMode(locked, 'chat')).toThrow('The execution mode is locked');
});

it('delegates tracing to each host and preserves results and errors', async () => {
    const labels: string[] = [];
    const host = createSessionHost({ traceBoot: async (label, operation) => { labels.push(label); return operation(); } });
    expect(await host.traceBoot('restore', async () => 42)).toBe(42);
    const error = new Error('Storage unavailable');
    await expect(host.traceBoot('load', async () => { throw error; })).rejects.toBe(error);
    await createSessionHost().traceBoot('other', async () => undefined);
    expect(labels).toEqual(['restore', 'load']);
});

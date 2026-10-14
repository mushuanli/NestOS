import { afterEach, expect, it, vi } from 'vitest';
import { createActionMetrics, type ActionSnapshot } from '../../../apps/tauri-app/src/log/action-metrics';
import { startVfsTrace } from '../../../apps/tauri-app/src/log/vfs-trace';
import { ipcCounter } from '../../../apps/tauri-app/src/log/ipc-counter-state';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses exact independent boundaries and copies starting counters', () => {
    const state: ActionSnapshot = { time: 10, vfs: { read: 5 }, sidecar: {}, ipc: { invoke: 4 } };
    const metrics = createActionMetrics(() => state);
    const first = metrics.begin('send');
    state.time = 20; state.ipc.invoke = 6;
    const second = metrics.begin('overlap');
    state.time = 30; state.vfs.read = 7; state.ipc.invoke = 7;
    expect(metrics.end(first)).toMatchObject({ elapsedMs: 20, ops: 2, ipcOps: 3 });
    state.time = 40; state.ipc.invoke = 8;
    expect(metrics.end(second)).toMatchObject({ elapsedMs: 20, ops: 2, ipcOps: 2 });
    expect(() => metrics.end(first)).toThrow('Unknown trace action');
});

it('rejects counter resets instead of reporting a misleading small measurement', () => {
    const state: ActionSnapshot = { time: 0, vfs: {}, sidecar: { get: 8 }, ipc: {} };
    const metrics = createActionMetrics(() => state), id = metrics.begin('send');
    state.sidecar.get = 1;
    expect(() => metrics.end(id)).toThrow('counter reset');
    const pending = metrics.begin('pending');
    metrics.stop();
    expect(() => metrics.begin('late')).toThrow('Trace stopped');
    expect(() => metrics.end(pending)).toThrow('Unknown trace action');
});

it('writes an action record without counting its diagnostic append', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async (_command: string, _args?: unknown) => undefined);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: Object.freeze({ invoke }) });
    const trace = startVfsTrace('/root', { ioStats: {} } as never);
    try {
        await ipcCounter.invoke('before');
        const id = trace.begin('send');
        await ipcCounter.invoke('during');
        const result = trace.end(id);
        await ipcCounter.invoke('after');
        expect(result).toMatchObject({ kind: 'action', ipcOps: 1, ipc: { during: 1 } });
        const append = invoke.mock.calls.find(call => call[0] === 'fs_append_file')!;
        const args = append[1] as { path: string; data: number[] };
        expect(args.path).toBe('/root/var/log/vfs-trace.log');
        const record = JSON.parse(new TextDecoder().decode(new Uint8Array(args.data)));
        expect(record).toMatchObject({ label: 'send', ipcOps: 1, ipc: { during: 1 } });
        await vi.advanceTimersByTimeAsync(2000);
        const writes = invoke.mock.calls.filter(call => call[0] === 'fs_append_file');
        expect(writes).toHaveLength(2);
        const interval = writes[1][1] as { data: number[] };
        expect(JSON.parse(new TextDecoder().decode(new Uint8Array(interval.data)))).toMatchObject({ kind: 'interval', ipcOps: 3 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(invoke.mock.calls.filter(call => call[0] === 'fs_append_file')).toHaveLength(2);
    } finally { trace(); }
    expect(() => trace.begin('late')).toThrow('Trace stopped');
});

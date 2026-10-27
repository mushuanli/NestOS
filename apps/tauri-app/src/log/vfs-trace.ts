/**
 * @file apps/tauri-app/src/log/vfs-trace.ts
 * @description VFS/IPC op trace for acceptance runs (build-time flag `VITE_NESTOS_TRACE=1`).
 *
 * VFS and sidecar counters describe logical operations, not IPC round trips.
 * The invoke counter separately records actual command submissions, including SQL
 * and native path checks. Trace writes use the original invoke and are excluded.
 * Appends one JSON line per changed interval to `<rootDir>/var/log/vfs-trace.log`
 * through the app's own fs commands.
 */
import type { IVFSManager } from '@itookit/vfs-core';
import type { LocalFSBackend } from '@itookit/vfsdriver-local';
import { ipcCounter } from './traced-core';
import { createActionMetrics, type ActionSnapshot } from './action-metrics';

export type VfsTraceControl = (() => void) & Pick<ReturnType<typeof createActionMetrics>, 'begin' | 'end'>;
declare global { interface Window { __NESTOS_TRACE__?: VfsTraceControl; } }

export interface VfsTraceOptions {
    intervalMs?: number;
    /** LocalFS sidecar counts, so idle IPC is measurable on both channels. */
    sidecar?: Pick<LocalFSBackend, 'sidecarStats'>;
}

function positiveDeltas(previous: Record<string, number>, current: Record<string, number>): Record<string, number> {
    const delta: Record<string, number> = {};
    for (const [key, value] of Object.entries(current)) {
        const change = value - (previous[key] ?? 0);
        if (change > 0) delta[key] = change;
    }
    return delta;
}

const total = (delta: Record<string, number>) => Object.values(delta).reduce((sum, value) => sum + value, 0);

function startIntervalTrace(snapshot: () => ActionSnapshot, append: (record: unknown) => void, intervalMs: number) {
    let previous = snapshot();
    const timer = setInterval(() => {
        const current = snapshot();
        const delta = positiveDeltas(previous.vfs, current.vfs);
        const sidecar = positiveDeltas(previous.sidecar, current.sidecar);
        const ipc = positiveDeltas(previous.ipc, current.ipc);
        previous = current;
        const ops = total(delta), sidecarOps = total(sidecar), ipcOps = total(ipc);
        if (ops || sidecarOps || ipcOps) append({ kind: 'interval', at: new Date().toISOString(), ops, delta, sidecarOps, sidecar, ipcOps, ipc });
    }, intervalMs);
    return () => clearInterval(timer);
}

export function startVfsTrace(
    rootDir: string,
    vfs: Pick<IVFSManager, 'ioStats'>,
    options: VfsTraceOptions = {},
): VfsTraceControl {
    const path = `${rootDir}/var/log/vfs-trace.log`;
    const append = (record: unknown) => {
        const data = Array.from(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
        void ipcCounter.uncounted('fs_append_file', { path, data }).catch(error => console.warn('[VfsTrace] append failed:', error));
    };
    const snapshot = () => ({ time: performance.now(), vfs: { ...vfs.ioStats },
        sidecar: options.sidecar ? { ...options.sidecar.sidecarStats } : {}, ipc: ipcCounter.snapshot() });
    const actions = createActionMetrics(snapshot);
    const stopInterval = startIntervalTrace(snapshot, append, options.intervalMs ?? 2_000);
    return Object.assign(() => { stopInterval(); actions.stop(); }, {
        begin: actions.begin,
        end(id: number) { const record = actions.end(id); append({ at: new Date().toISOString(), ...record }); return record; },
    });
}

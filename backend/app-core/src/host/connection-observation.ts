import { FSError } from '@itookit/vfs-core';
import type { ConnectionObservation, ProjectRemoteMountPort } from '@itookit/app-contracts/services';

const monitors = new WeakMap<ProjectRemoteMountPort, ConnectionMonitor>();

/** All clients of one runtime share a bounded probe loop. */
export function observeConnections(remote: ProjectRemoteMountPort): ConnectionObservation {
    let monitor = monitors.get(remote);
    if (!monitor) { monitor = new ConnectionMonitor(remote); monitors.set(remote, monitor); }
    return monitor.open();
}

class ConnectionMonitor {
    private readonly interests = new Map<object, Set<string>>();
    private timer?: ReturnType<typeof setTimeout>;
    private running?: AbortController;
    private rerun = false;
    private signatures = new Set<string>();
    private unsubscribe?: () => void;
    constructor(private readonly remote: ProjectRemoteMountPort) {}
    open(): ConnectionObservation {
        const token = {}; let revision = -1, closed = false;
        return {
            update: async (ids, next) => {
                if (closed || next <= revision) return;
                if (!Number.isSafeInteger(next) || !Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== 'string' || id.length > 256))
                    throw new FSError('EINVAL', 'Invalid connection interest');
                revision = next;
                this.interests.set(token, new Set(ids));
                this.reconcile();
            },
            dispose: async () => { if (closed) return; closed = true; this.interests.delete(token); this.reconcile(); },
        };
    }
    private reconcile(): void {
        const interested = new Set([...this.interests.values()].flatMap(ids => [...ids]));
        if (interested.size) this.unsubscribe ??= this.remote.onChange(() => this.reconcile());
        else { this.unsubscribe?.(); this.unsubscribe = undefined; }
        const signatures = new Set([...interested].flatMap(id => this.remote.list(id).map(mount => JSON.stringify([id, mount]))));
        const added = [...signatures].some(signature => !this.signatures.has(signature));
        this.signatures = signatures;
        if (!signatures.size) this.stop(); else if (added) this.request();
    }
    private ids(): Set<string> {
        return new Set([...this.interests.values()].flatMap(ids => [...ids]).filter(id => this.remote.list(id).length > 0));
    }
    private stop(): void { clearTimeout(this.timer); this.timer = undefined; this.running?.abort(); this.rerun = false; }
    private request(): void {
        clearTimeout(this.timer); this.timer = undefined;
        if (this.running) { this.rerun = true; return; }
        const controller = this.running = new AbortController();
        void this.poll(controller).finally(() => {
            this.running = undefined;
            if (!this.ids().size) return;
            if (this.rerun || controller.signal.aborted) { this.rerun = false; this.request(); }
            else this.timer = setTimeout(() => this.request(), 15_000);
        });
    }
    private async poll(controller: AbortController): Promise<void> {
        const ids = [...this.ids()];
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
            while (ids.length && !controller.signal.aborted) {
                const id = ids.shift()!;
                if (!this.ids().has(id)) continue;
                try { await this.remote.checkConnections(id, { signal: controller.signal, timeoutMs: 3000 }); }
                catch { /* Availability diagnostics belong to the remote mount service. */ }
            }
        }));
    }
}

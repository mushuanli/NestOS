import type { HarnessObservation, HarnessStatusPort, HarnessStatusRow } from '@itookit/piagent-driver';
import type { OperationOptions } from '@itookit/vfs-core';

interface Watch {
    fileVersion?: string;
    identity: string; listeners: Set<() => void>; rows: HarnessStatusRow[]; abort: AbortController;
    port?: HarnessStatusPort; timer?: ReturnType<typeof setTimeout>; work?: Promise<void>; failures: number;
}
/** Ref-counted project observers. Identity includes configuration, server, grants and revision. */
export class RemoteSessionStatus {
    private readonly watches = new Map<string, Watch>();
    constructor(private readonly identity: (projectId: string) => string | undefined,
        private readonly open: (projectId: string, options: OperationOptions) => Promise<HarnessStatusPort>) {}
    get(projectId: string, profileId: string, sessionId: string): HarnessObservation | undefined {
        return this.record(projectId, profileId, sessionId)?.observation;
    }
    record(projectId: string, profileId: string, sessionId: string): HarnessStatusRow | undefined {
        const watch = this.watches.get(projectId);
        if (!watch || watch.identity !== this.identity(projectId)) return;
        return watch.rows.find(row => row.profileId === profileId && row.sessionId === sessionId);
    }
    fileVersion(projectId: string): string | undefined {
        const watch = this.watches.get(projectId);
        if (!watch || watch.identity !== this.identity(projectId)) return;
        return [...new Set(watch.rows.filter(row => row.fileVersion).map(row => `${row.profileId}:${row.fileVersion}`).concat(watch.fileVersion ? [watch.fileVersion] : []))].sort().join('|') || undefined;
    }
    subscribe(projectId: string, listener: () => void): () => void {
        let watch = this.watches.get(projectId);
        if (!watch) {
            watch = {identity: this.identity(projectId) ?? '', listeners: new Set(), rows: [], abort: new AbortController(), failures: 0};
            this.watches.set(projectId, watch);
        }
        const notify = () => listener();
        watch.listeners.add(notify);
        if (!watch.timer && !watch.work) this.schedule(projectId, watch, 0);
        return () => { watch!.listeners.delete(notify); if (!watch!.listeners.size) void this.stop(projectId, watch!).catch(() => {}); };
    }
    private schedule(id: string, watch: Watch, delay: number) {
        watch.timer = setTimeout(() => { watch.timer = undefined; watch.work = this.poll(id, watch).finally(() => { watch.work = undefined; }); }, delay);
    }
    private async poll(id: string, watch: Watch) {
        try {
            const identity = this.identity(id);
            if (!identity) { watch.rows = []; for (const listener of watch.listeners) listener(); await this.stop(id, watch); return; }
            if (watch.identity !== identity) {
                watch.rows = []; watch.fileVersion = undefined; watch.identity = identity; await watch.port?.close(); watch.port = undefined;
            }
            const options = {signal: watch.abort.signal, timeoutMs: 5000};
            watch.port ??= await this.open(id, options);
            if (watch.abort.signal.aborted) { await watch.port.close(); return; }
            const rows = await watch.port.poll(options);
            if (watch.abort.signal.aborted || identity !== this.identity(id)) return;
            const meaningful = (values: HarnessStatusRow[]) => JSON.stringify(values.map(row => ({...row, observation: {...row.observation, observedAt: 0}})));
            const fileVersion = watch.port.fileVersion?.();
            const changed = meaningful(rows) !== meaningful(watch.rows) || fileVersion !== watch.fileVersion;
            watch.fileVersion = fileVersion;
            watch.rows = rows; watch.failures = rows.some(row => row.observation.connection === 'offline') ? watch.failures + 1 : 0;
            if (changed) for (const listener of watch.listeners) listener();
        } catch {
            watch.failures++;
            watch.rows = watch.rows.map(row => ({...row, observation: {...row.observation, stale: true, connection: 'offline', canInterrupt: false, canRespond: false}}));
            if (!watch.abort.signal.aborted) for (const listener of watch.listeners) listener();
        } finally {
            if (!watch.abort.signal.aborted) this.schedule(id, watch, Math.min(30_000, 1000 * 2 ** Math.min(watch.failures, 5)));
        }
    }
    private async stop(id: string, watch: Watch) {
        watch.abort.abort(); clearTimeout(watch.timer);
        if (this.watches.get(id) === watch) this.watches.delete(id);
        await watch.port?.close();
    }
    async dispose() { await Promise.all([...this.watches].map(([id, watch]) => this.stop(id, watch))); }
}

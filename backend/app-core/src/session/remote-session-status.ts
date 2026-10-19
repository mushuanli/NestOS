import type { HarnessObservation, HarnessStatusPort, HarnessStatusRow } from '@itookit/mindos-node-driver';
import type { OperationOptions } from '@itookit/vfs-core';

interface Watch {
    fileVersion?: string;
    identity: string; listeners: Set<() => void>; rows: HarnessStatusRow[]; abort: AbortController;
    port?: HarnessStatusPort; timer?: ReturnType<typeof setTimeout>; work?: Promise<void>; failures: number;
    refreshRequested?: boolean;
}
interface CachedStatus { identity: string; rows: HarnessStatusRow[]; fileVersion?: string; expiresAt: number }
/** Ref-counted project observers. Identity includes configuration, server, grants and revision. */
export class RemoteSessionStatus {
    private readonly watches = new Map<string, Watch>();
    private readonly cached = new Map<string, CachedStatus>();
    constructor(private readonly identity: (projectId: string) => string | undefined,
        private readonly open: (projectId: string, options: OperationOptions) => Promise<HarnessStatusPort>) {}
    get(projectId: string, profileId: string, sessionId: string): HarnessObservation | undefined {
        return this.record(projectId, profileId, sessionId)?.observation;
    }
    record(projectId: string, profileId: string, sessionId: string): HarnessStatusRow | undefined {
        const watch = this.projection(projectId);
        if (!watch || watch.identity !== this.identity(projectId)) return;
        return watch.rows.find(row => row.profileId === profileId && row.sessionId === sessionId);
    }
    fileVersion(projectId: string): string | undefined {
        const watch = this.projection(projectId);
        if (!watch || watch.identity !== this.identity(projectId)) return;
        return [...new Set(watch.rows.filter(row => row.fileVersion).map(row => `${row.profileId}:${row.fileVersion}`).concat(watch.fileVersion ? [watch.fileVersion] : []))].sort().join('|') || undefined;
    }
    subscribe(projectId: string, listener: () => void): () => void {
        let watch = this.watches.get(projectId);
        if (!watch) {
            const cached = this.projection(projectId);
            watch = {identity: this.identity(projectId) ?? '', listeners: new Set(), rows: cached?.rows ?? [],
                fileVersion: cached?.fileVersion, abort: new AbortController(), failures: 0};
            this.cached.delete(projectId);
            this.watches.set(projectId, watch);
        }
        const notify = () => listener();
        watch.listeners.add(notify);
        if (!watch.timer && !watch.work) this.schedule(projectId, watch, 0);
        return () => { watch!.listeners.delete(notify); if (!watch!.listeners.size) void this.stop(projectId, watch!).catch(() => {}); };
    }
    async refresh(projectId: string): Promise<void> {
        const watch = this.watches.get(projectId);
        if (!watch || watch.abort.signal.aborted) return;
        clearTimeout(watch.timer); watch.timer = undefined;
        if (watch.work) { watch.refreshRequested = true; await watch.work; return; }
        watch.work ??= this.poll(projectId, watch).finally(() => { watch.work = undefined; });
        await watch.work;
    }
    private schedule(id: string, watch: Watch, delay: number) {
        watch.timer = setTimeout(() => { watch.timer = undefined; watch.work = this.poll(id, watch).finally(() => { watch.work = undefined; }); }, delay);
    }
    private async poll(id: string, watch: Watch) {
        try {
            const identity = this.identity(id);
            if (!identity) { watch.rows = []; this.notify(watch); await this.stop(id, watch); return; }
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
            watch.rows = rows; watch.failures = rows.some(row => row.observation.connection === 'offline' || row.observation.refreshError) ? watch.failures + 1 : 0;
            if (changed) this.notify(watch);
        } catch {
            if (watch.abort.signal.aborted) return;
            watch.failures++;
            if (watch.failures === 1) console.warn('[Harness] Status observation failed');
            watch.rows = watch.rows.map(row => ({...row, observation: {...row.observation, stale: true,
                refreshError: {stage: 'status', code: 'OBSERVATION_ERROR'}, canInterrupt: false, canRespond: false}}));
            this.notify(watch);
        } finally { this.scheduleAfterPoll(id, watch); }
    }
    private scheduleAfterPoll(id: string, watch: Watch): void {
        const active = watch.rows.some(row => row.observation.execution === 'running'
            || row.observation.execution === 'waiting-approval' || row.observation.execution === 'waiting-input' || row.observation.receiptUnknown);
        const requested = watch.refreshRequested; watch.refreshRequested = false;
        if (!watch.abort.signal.aborted && (active || requested)) this.schedule(id, watch, requested ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(watch.failures, 5)));
    }
    private notify(watch: Watch): void {
        for (const listener of watch.listeners) {
            try { listener(); } catch { console.warn('[Harness] Status subscriber failed'); }
        }
    }
    private async stop(id: string, watch: Watch) {
        this.remember(id, watch);
        watch.abort.abort(); clearTimeout(watch.timer);
        if (this.watches.get(id) === watch) this.watches.delete(id);
        await watch.port?.close();
    }
    private projection(id: string): Watch | CachedStatus | undefined {
        const watch = this.watches.get(id);
        if (watch) return watch.identity === this.identity(id) ? watch : undefined;
        const cached = this.cached.get(id);
        if (cached && cached.expiresAt > Date.now() && cached.identity === this.identity(id)) return cached;
        this.cached.delete(id); return undefined;
    }
    private remember(id: string, watch: Watch): void {
        if (watch.abort.signal.aborted || watch.identity !== this.identity(id) || watch.rows.length > 512) return;
        this.cached.delete(id);
        const rows = watch.rows.map(row => ({...row, observation: {...row.observation, stale: true, canInterrupt: false, canRespond: false}}));
        this.cached.set(id, { identity: watch.identity, rows, fileVersion: watch.fileVersion, expiresAt: Date.now() + 30_000 });
        while (this.cached.size > 64 || [...this.cached.values()].reduce((count, entry) => count + entry.rows.length, 0) > 4096)
            this.cached.delete(this.cached.keys().next().value!);
    }
    async dispose() { await Promise.all([...this.watches].map(([id, watch]) => this.stop(id, watch))); this.cached.clear(); }
}

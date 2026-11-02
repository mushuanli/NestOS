import type {ConversationControls, ConversationSnapshot} from '../contracts';
import {createModuleLogger, randomUUID} from '@itookit/common';

const log = createModuleLogger('native-metrics');
/** Refresh at session/turn boundaries, never on token deltas or an independent timer. */
export class NativeMetricsObserver {
    private state?: ConversationSnapshot;
    private key?: string;
    private completed?: string;
    private busy = false;
    private active = true;
    private closed = false;
    constructor(private readonly controls: ConversationControls, private readonly changed: (state: ConversationSnapshot) => void) {}
    observe(state: ConversationSnapshot): void {
        this.state = state;
        this.key = state.supportsMetrics && state.sessionId && this.controls.refreshMetrics
            ? JSON.stringify([state.sessionId, state.observation?.activeTurnId ?? null, state.observation?.lastResult ?? null]) : undefined;
        this.schedule();
    }
    private schedule(): void {
        if (this.closed || !this.active || this.busy || !this.key || this.key === this.completed) return;
        void this.read(this.key, this.state!.sessionId!);
    }
    private async read(key: string, sessionId: string): Promise<void> {
        this.busy = true; this.completed = key;
        const operationId = randomUUID(), started = Date.now();
        try {
            const state = await this.controls.refreshMetrics!();
            if (!this.closed && this.active && state.sessionId === sessionId && this.state?.sessionId === sessionId) this.changed(state);
        } catch (error) {
            const raw = (error as {code?: string})?.code;
            const code = raw && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'HARNESS_METRICS_UNAVAILABLE';
            try {log.warn('chat.native.metrics', {operationId, stage: 'refresh', result: 'failure', code, durationMs: Date.now() - started});} catch { /* Diagnostics are observational. */ }
            if (!this.closed && this.active && this.state?.sessionId === sessionId) this.changed({...this.state, metricsError: {code}});
        } finally {this.busy = false; this.schedule();}
    }
    setActive(value: boolean): void {this.active = value; if (!value) this.completed = undefined; else this.schedule();}
    dispose(): void {this.closed = true;}
}

import {randomUUID} from '@itookit/common';

export interface RecoverableView<T> {
    captureRecovery(): T;
    suspendForRecovery(): void;
    destroy(): Promise<void>;
}

/** Keep the checkpoint in memory across failed reconstruction, without replaying writes. */
export class ViewRecovery<T, V extends RecoverableView<T>> {
    private checkpoint?: {state: T};
    private running?: Promise<void>;
    private closed = false;
    private released = false;
    constructor(public current: V, private readonly open: (state: T) => Promise<V>) {}
    recover(): Promise<void> {
        if (this.closed) return Promise.resolve();
        return this.running ??= this.run().finally(() => {this.running = undefined;});
    }
    private async run(): Promise<void> {
        const operationId = randomUUID(), started = performance.now();
        let stage = 'capture';
        try {
            if (!this.checkpoint) {
                this.checkpoint = {state: this.current.captureRecovery()};
            }
            if (!this.released) {
                this.current.suspendForRecovery(); stage = 'release';
                await this.current.destroy();
                this.released = true;
            }
            if (this.closed) return;
            stage = 'open';
            const next = await this.open(this.checkpoint.state);
            if (this.closed) {next.suspendForRecovery(); await next.destroy(); return;}
            this.current = next; this.checkpoint = undefined; this.released = false;
            console.info('http.view.recovery', {operationId, stage: 'complete', outcome: 'success', durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            console.warn('http.view.recovery', {operationId, stage, outcome: 'failure',
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RECOVERY_FAILED', durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    }
    async close(): Promise<void> {
        this.closed = true;
        await this.running?.catch(() => {});
        if (!this.released) await this.current.destroy(); this.checkpoint = undefined;
    }
}

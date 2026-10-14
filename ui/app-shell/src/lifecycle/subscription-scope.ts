/** Synchronous subscriptions only; async resource disposal has a separate owner. */
export class SubscriptionScope {
    private cleanups: Array<() => void> = [];
    private closed = false;
    add(...cleanups: Array<() => void>): void {
        if (this.closed) { this.release(cleanups); return; }
        this.cleanups.push(...cleanups);
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        this.release(this.cleanups.splice(0).reverse());
    }
    private release(cleanups: Array<() => void>): void {
        const errors: unknown[] = [];
        for (const cleanup of cleanups) {
            try { cleanup(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Subscription cleanup failed');
    }
}

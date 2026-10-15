import { FSError } from '@itookit/vfs-core';

/** Explicit disposal and view closure join the same resource cleanup. */
export class ViewScope {
    private readonly releases = new Set<() => Promise<void>>();
    private closed = false;
    private closing?: Promise<void>;
    async own<T extends { dispose(): unknown }>(value: T): Promise<T> {
        if (this.closed) { await value.dispose(); throw new FSError('EIO', 'View scope is closed'); }
        const dispose = value.dispose.bind(value); let pending: Promise<void> | undefined;
        const release = () => pending ??= Promise.resolve().then(async () => { await dispose(); }).finally(() => { this.releases.delete(release); });
        this.releases.add(release);
        return new Proxy(value, { get(target, key) {
            if (key === 'dispose') return release;
            const item = Reflect.get(target, key, target); return typeof item === 'function' ? item.bind(target) : item;
        } });
    }
    close(): Promise<void> { return this.closing ??= this.releaseAll(); }
    private async releaseAll(): Promise<void> {
        this.closed = true;
        const results = await Promise.allSettled([...this.releases].reverse().map(release => release()));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'View cleanup failed');
    }
}

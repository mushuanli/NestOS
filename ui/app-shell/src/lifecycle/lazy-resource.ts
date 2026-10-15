import { FSError } from '@itookit/vfs-core';

/** Share construction, retry failures, and release a value even if closure races creation. */
export function lazyResource<T>(create: () => Promise<T>, dispose: (value: T) => void | Promise<void>) {
    let pending: Promise<T> | undefined, release: Promise<void> | undefined, closing: Promise<void> | undefined, closed = false;
    const retire = (value: T) => release ??= Promise.resolve().then(() => dispose(value));
    return {
        get(): Promise<T> {
            if (closed) return Promise.reject(new FSError('EIO', 'Resource closed'));
            if (!pending) {
                const task = Promise.resolve().then(create).then(async value => {
                    if (closed) { await retire(value); throw new FSError('EIO', 'Resource closed'); }
                    return value;
                });
                pending = task; void task.catch(() => { if (!closed && pending === task) pending = undefined; });
            }
            return pending;
        },
        close(): Promise<void> {
            closed = true;
            return closing ??= (pending?.then(retire, () => release) ?? Promise.resolve()).then(() => {});
        },
    };
}

import {AsyncLocalStorage} from 'node:async_hooks';
import {expect, vi} from 'vitest';
import type {Kernel} from '@itookit/durable-kernel';

/** Count activations caused by this query, excluding already-running cleanup and queue workers. */
export async function coldQuery<T>(kernel: Pick<Kernel, 'openSession'>, query: () => Promise<T>): Promise<T> {
    const scope = new AsyncLocalStorage<boolean>(), original = kernel.openSession.bind(kernel);
    let activations = 0;
    const spy = vi.spyOn(kernel, 'openSession').mockImplementation((...args) => {
        if (scope.getStore()) activations++;
        return original(...args);
    });
    try {
        const result = await scope.run(true, query);
        expect(activations, 'Cold query activated Session execution').toBe(0);
        return result;
    } finally {spy.mockRestore(); scope.disable();}
}

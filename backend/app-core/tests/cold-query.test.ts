import {expect, it} from 'vitest';
import type {Kernel} from '@itookit/durable-kernel';
import {coldQuery} from './helpers/cold-query';

function fixture() {
    let count = 0;
    const openSession = async () => {count++; return {};};
    return {openSession, calls: () => count, kernel: {openSession} as unknown as Pick<Kernel, 'openSession'>};
}
it('allows an existing background worker to open a Session while a cold query waits', async () => {
    const {kernel, calls} = fixture(); let release!: () => void;
    const background = new Promise<void>(resolve => {release = resolve;}).then(() => kernel.openSession('background'));
    expect(await coldQuery(kernel, async () => {release(); await background; return 'receipt';})).toBe('receipt');
    expect(calls()).toBe(1);
});
it('rejects Session activation by the query itself, including after an asynchronous boundary', async () => {
    const {kernel, openSession} = fixture();
    await expect(coldQuery(kernel, async () => {await Promise.resolve(); return kernel.openSession('query');})).rejects.toThrow('Cold query activated');
    expect(kernel.openSession).toBe(openSession);
});
it('preserves the original query failure and restores the observer', async () => {
    const {kernel, openSession} = fixture(), failure = new Error('Read failed');
    await expect(coldQuery(kernel, async () => {throw failure;})).rejects.toBe(failure);
    expect(kernel.openSession).toBe(openSession);
});

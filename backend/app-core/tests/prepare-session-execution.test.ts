import {expect, it, vi} from 'vitest';
import {KernelError, KernelErrorCode} from '@itookit/durable-kernel';
import {createSessionExecutionPreparer} from '../src/session/prepare-session-execution';

it('prepares storage only after the metadata lease and refuses a denied owner before Kernel access', async () => {
    const kernel = {openSession: vi.fn(async () => {}), createSession: vi.fn()};
    const acquire = vi.fn(async () => false), prepare = createSessionExecutionPreparer(kernel as never, acquire);
    await expect(prepare('denied')).rejects.toMatchObject({code: 'SESSION_EXECUTION_READ_ONLY'});
    expect(kernel.openSession).not.toHaveBeenCalled(); expect(kernel.createSession).not.toHaveBeenCalled();
    acquire.mockImplementation(async () => true);
    await prepare('allowed');
    expect(acquire.mock.invocationCallOrder.at(-1)).toBeLessThan(kernel.openSession.mock.invocationCallOrder[0]);
});

it('coalesces preparation of one identity and uses the same storage when creating it', async () => {
    let fail!: (reason: unknown) => void;
    const kernel = {openSession: vi.fn((_id: string, _storage: unknown) => new Promise((_, reject) => {fail = reject;})), createSession: vi.fn(async () => ({}))};
    const prepare = createSessionExecutionPreparer(kernel as never);
    const first = prepare('draft'), second = prepare('draft');
    expect(first).toBe(second); expect(kernel.openSession).toHaveBeenCalledOnce();
    fail(new KernelError(KernelErrorCode.SESSION_NOT_FOUND, 'Missing'));
    await first;
    expect(kernel.createSession).toHaveBeenCalledWith({id: 'draft', storage: kernel.openSession.mock.calls[0][1]});
});
it('propagates storage errors without creating another Session and permits retry', async () => {
    const failure = new Error('Storage unavailable');
    const kernel = {openSession: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({}), createSession: vi.fn()};
    const prepare = createSessionExecutionPreparer(kernel as never);
    await expect(prepare('draft')).rejects.toBe(failure);
    await expect(prepare('draft')).resolves.toBeUndefined();
    expect(kernel.createSession).not.toHaveBeenCalled();
});

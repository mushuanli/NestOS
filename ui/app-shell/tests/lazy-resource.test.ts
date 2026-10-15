import { expect, it, vi } from 'vitest';
import { lazyResource } from '../src/lifecycle/lazy-resource';

it('shares construction, retries failed creation, and disposes once', async () => {
    const value = {}, create = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(value), dispose = vi.fn();
    const resource = lazyResource(create, dispose);
    await expect(resource.get()).rejects.toThrow('offline');
    const first = resource.get(); expect(resource.get()).toBe(first);
    await expect(first).resolves.toBe(value); expect(create).toHaveBeenCalledTimes(2);
    await Promise.all([resource.close(), resource.close()]); expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
    await expect(resource.get()).rejects.toMatchObject({ code: 'EIO' });
});
it('does not create an unused resource during close', async () => {
    const create = vi.fn(), dispose = vi.fn(), resource = lazyResource(create, dispose);
    await resource.close(); await expect(resource.get()).rejects.toMatchObject({ code: 'EIO' });
    expect(create).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
});
it('waits for late creation and releases it before rejecting a closed access', async () => {
    let finish!: (value: object) => void;
    const dispose = vi.fn(), resource = lazyResource(() => new Promise<object>(resolve => { finish = resolve; }), dispose);
    const pending = resource.get(), rejected = expect(pending).rejects.toMatchObject({ code: 'EIO' });
    await Promise.resolve(); const close = resource.close(), value = {}; finish(value);
    await Promise.all([close, rejected]); expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
});
it('preserves disposal failures when closure races creation', async () => {
    let finish!: (value: object) => void;
    const resource = lazyResource(() => new Promise<object>(resolve => { finish = resolve; }), () => { throw new Error('release failed'); });
    const pending = resource.get(), rejected = expect(pending).rejects.toThrow('release failed');
    await Promise.resolve(); const closing = expect(resource.close()).rejects.toThrow('release failed'); finish({});
    await Promise.all([rejected, closing]);
});

import { expect, it, vi } from 'vitest';
import { ViewLoad, ViewLoadCancelled } from '../src/lifecycle/view-load';

it('releases the caller immediately but retains the source until an uncancellable read settles', async () => {
    const controller = new AbortController(), load = new ViewLoad(controller.signal);
    let finish!: (content: string) => void;
    const read = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const reading = load.read(read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const cancelled = expect(reading).rejects.toBeInstanceOf(ViewLoadCancelled);
    controller.abort(); await cancelled;
    const release = vi.fn();
    const draining = load.drain().then(release);
    await Promise.resolve(); expect(release).not.toHaveBeenCalled();
    finish('obsolete bytes'); await draining;
    expect(release).toHaveBeenCalledOnce();
});

it('does not start queued reads after cancellation and safely drains late failures', async () => {
    const controller = new AbortController(), load = new ViewLoad(controller.signal);
    let fail!: (error: Error) => void;
    const first = load.read(() => new Promise<void>((_, reject) => { fail = reject; }));
    await Promise.resolve();
    const cancelled = expect(first).rejects.toBeInstanceOf(ViewLoadCancelled);
    controller.abort(); await cancelled;
    const next = vi.fn(async () => 'unused');
    expect(() => load.read(next)).toThrow(ViewLoadCancelled);
    expect(next).not.toHaveBeenCalled();
    fail(new Error('late storage failure')); await load.drain();
});

it('keeps independent view owners isolated while replacing the current request', async () => {
    const { LatestViewLoad } = await import('../src/lifecycle/view-load');
    const owner = new LatestViewLoad(), other = new LatestViewLoad();
    const first = owner.begin(), independent = other.begin(), latest = owner.begin();
    expect(first.signal.aborted).toBe(true);
    expect(owner.isCurrent(latest)).toBe(true);
    owner.cancel();
    expect(owner.isCurrent(latest)).toBe(false);
    expect(other.isCurrent(independent)).toBe(true);
});

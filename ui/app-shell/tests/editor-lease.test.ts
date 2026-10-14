import { expect, it, vi } from 'vitest';
import { EditorLease } from '../src/browser/editor-lease';

it('retains file ownership on save failure and releases exactly once after retry', async () => {
    const destroy = vi.fn(async () => {}), release = vi.fn(async () => {});
    destroy.mockRejectedValueOnce(new Error('disk full'));
    const lease = new EditorLease({ destroy } as any, release);
    await expect(lease.dispose()).rejects.toThrow('disk full');
    expect(release).not.toHaveBeenCalled();
    const first = lease.dispose(), second = lease.dispose();
    expect(second).toBe(first); await first; await lease.dispose();
    expect(release).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledTimes(2);
});

it('does not release capabilities until slow editor destruction completes', async () => {
    let finish!: () => void;
    const destroy = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const release = vi.fn(async () => {}), lease = new EditorLease({ destroy } as any, release);
    const closing = lease.dispose(); await Promise.resolve();
    expect(release).not.toHaveBeenCalled(); finish(); await closing;
    expect(release).toHaveBeenCalledOnce();
});

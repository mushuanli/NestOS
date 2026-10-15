import { expect, it, vi } from 'vitest';
import { ViewScope } from '../src/host/view-scope';

it('joins in-flight disposal before closing and cleans a late resource instead of publishing it', async () => {
    let finish!: () => void;
    const scope = new ViewScope(), dispose = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const resource = await scope.own({ dispose });
    const released = resource.dispose(), closed = scope.close(), complete = vi.fn();
    void closed.then(complete); await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
    finish(); await Promise.all([released, closed, scope.close()]);
    expect(complete).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    const late = vi.fn(async () => {});
    await expect(scope.own({ dispose: late })).rejects.toMatchObject({ code: 'EIO' });
    expect(late).toHaveBeenCalledOnce();
});

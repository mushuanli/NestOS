import {expect, it, vi} from 'vitest';
import type {SessionHandle} from '@itookit/durable-kernel';
import {fenceSchedulerSession} from '../src/flow/fenced-session';

it('fences pause withdrawal on submitted, attached and retried tasks without replacing control identity', async () => {
    const control = {epoch: 8, mode: 'run', acknowledged: false};
    const withdrawPause = vi.fn(async () => control);
    const retry = vi.fn(async () => ({withdrawPause}));
    const task = {withdrawPause, retry};
    const session = {submit: vi.fn(async () => task), attachTask: vi.fn(async () => task)};
    const condition = {key: 'scheduler.root', ownerId: 'host-a', epoch: 3};
    const fenced = fenceSchedulerSession(session as unknown as SessionHandle, condition);
    condition.epoch = 99;
    const submitted = await fenced.submit({} as never), attached = await fenced.attachTask('root');
    const retried = await submitted.retry();
    for (const handle of [submitted, attached, retried]) {
        expect(await handle.withdrawPause({requestId: 'withdraw-original', expectedEpoch: 7,
            lease: {key: 'wrong', ownerId: 'caller', epoch: 100}})).toBe(control);
    }
    expect(withdrawPause).toHaveBeenCalledTimes(3);
    for (const [options] of withdrawPause.mock.calls as unknown as Array<[unknown]>) {
        expect(options).toEqual({requestId: 'withdraw-original', expectedEpoch: 7,
            lease: {key: 'scheduler.root', ownerId: 'host-a', epoch: 3}});
    }
    withdrawPause.mockRejectedValueOnce(Object.assign(new Error('Lease lost'), {code: 'CONFLICT'}));
    await expect(attached.withdrawPause({requestId: 'withdraw-stale', expectedEpoch: 7}))
        .rejects.toMatchObject({code: 'CONFLICT'});
    expect(withdrawPause).toHaveBeenCalledTimes(4);
});

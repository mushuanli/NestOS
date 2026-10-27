import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ entry: undefined as unknown, dispose: vi.fn(), opened: vi.fn() }));
vi.mock('../src/runtime', () => ({
    openProfileInspectionFs: async () => { state.opened(); return { fs: {}, dispose: state.dispose }; },
    CliStorageResolver: class { async resolve() { return {}; } },
    cliStorage: (id: string) => ({ id }),
}));
vi.mock('@itookit/durable-kernel', () => ({
    SeqFileKernelStore: class { async getShared() { return state.entry; } },
}));
import { assertRunNotScheduled } from '../src/run-scheduler-lease';
const ref = { vfsRoot: '/profile', sessionId: 's', rootTaskId: 'root' };
const lease = (expiresAt: number) => ({ version: 1, ownerId: 'other-host', epoch: 1, expiresAt });
afterEach(() => { state.entry = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each([null, {}, { ...lease(5), version: 2 }, lease(-1), lease(0.5)])(
    'refuses malformed or unsupported scheduler records: %j', async value => {
        state.entry = { value };
        await expect(assertRunNotScheduled(ref, 100)).rejects.toThrow('invalid scheduler lease');
        expect(state.dispose).toHaveBeenCalledOnce();
    },
);

it('keeps an expired lease protected through the configured clock allowance', async () => {
    vi.stubEnv('NESTOS_SCHEDULER_LEASE_SKEW_MS', '200');
    state.entry = { value: lease(1000) };
    await expect(assertRunNotScheduled(ref, 1199)).rejects.toThrow('other-host');
    await expect(assertRunNotScheduled(ref, 1200)).resolves.toBeUndefined();
    state.entry = { value: lease(0) };
    await expect(assertRunNotScheduled(ref, 10)).resolves.toBeUndefined();
});

it('rejects an invalid allowance before opening inspection storage', async () => {
    vi.stubEnv('NESTOS_SCHEDULER_LEASE_SKEW_MS', 'NaN');
    await expect(assertRunNotScheduled(ref)).rejects.toThrow('non-negative safe integer');
    expect(state.opened).not.toHaveBeenCalled();
});

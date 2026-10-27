import { afterEach, expect, it, vi } from 'vitest';
import { leaseSkewConfig } from '../src/lease-config';
import { createCliRuntime } from '../src/runtime';

afterEach(() => vi.unstubAllEnvs());

it('preserves missing, zero and distinct explicit allowances', () => {
    expect(leaseSkewConfig({})).toEqual({ sessionSkewMs: undefined, schedulerSkewMs: undefined });
    expect(leaseSkewConfig({ NESTOS_SESSION_LEASE_SKEW_MS: '0', NESTOS_SCHEDULER_LEASE_SKEW_MS: '5000' }))
        .toEqual({ sessionSkewMs: 0, schedulerSkewMs: 5000 });
});

it.each(['NESTOS_SESSION_LEASE_SKEW_MS', 'NESTOS_SCHEDULER_LEASE_SKEW_MS'])('validates %s before opening runtime resources', async key => {
    for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '0.5', '9007199254740992', 'invalid']) {
        expect(() => leaseSkewConfig({ [key]: value })).toThrow(key);
        vi.stubEnv(key, value);
        // Invalid arguments prove that environment validation precedes runtime assembly.
        await expect(createCliRuntime(undefined as never, undefined as never, async () => undefined)).rejects.toThrow(key);
        vi.unstubAllEnvs();
    }
});

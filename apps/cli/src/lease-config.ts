/** Parse takeover allowances before opening storage or acquiring any leases. */
export function leaseSkewConfig(env: Record<string, string | undefined>) {
    return {
        sessionSkewMs: allowance(env, 'NESTOS_SESSION_LEASE_SKEW_MS'),
        schedulerSkewMs: allowance(env, 'NESTOS_SCHEDULER_LEASE_SKEW_MS'),
    };
}

function allowance(env: Record<string, string | undefined>, key: string): number | undefined {
    const raw = env[key];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${key} must be a non-negative safe integer in milliseconds`);
    }
    return value;
}

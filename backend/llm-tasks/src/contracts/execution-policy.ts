import { DEFAULT_EFFECT_TIMEOUT_MS } from './execution-defaults';

export interface LlmRetryPolicy { retries?: number; backoffMs?: number; }

/** Numerical bounds protect persisted Kernel attempts without choosing a host retry cap. */
export function resolveLlmRetryPolicy(policy: LlmRetryPolicy = {}) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid llmRetry policy');
    const retries = policy.retries ?? 3, backoffMs = policy.backoffMs ?? 1000;
    if (!Number.isSafeInteger(retries) || retries < 0 || retries >= Number.MAX_SAFE_INTEGER
        || !Number.isFinite(backoffMs) || backoffMs < 0) throw new Error('Invalid llmRetry policy');
    return Object.freeze({ retries, backoffMs });
}

export function resolveToolTimeoutMs(value = DEFAULT_EFFECT_TIMEOUT_MS): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Tool timeout must be a positive safe integer');
    return value;
}

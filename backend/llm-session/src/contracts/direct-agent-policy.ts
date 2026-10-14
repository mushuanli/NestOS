import { DEFAULT_AGENT_MAX_EXCHANGES, resolveLlmRetryPolicy, resolveToolTimeoutMs, type LlmRetryPolicy } from '@itookit/llm-tasks/contracts';

/** Host instructions and exchange budget for direct Agent sends; Flow keeps its own policy. */
export interface DirectAgentPolicy {
    systemPrompt?: readonly string[];
    maxExchanges?: number;
    llmRetry?: LlmRetryPolicy;
    toolTimeoutMs?: number;
}

export interface ResolvedDirectAgentPolicy {
    readonly systemPrompt: readonly string[];
    readonly maxExchanges: number;
    readonly llmRetry?: Readonly<LlmRetryPolicy>;
    readonly toolTimeoutMs?: number;
}

/** Validate and detach host-owned data before asynchronous admission. */
export function snapshotDirectAgentPolicy(policy: DirectAgentPolicy = {}): ResolvedDirectAgentPolicy {
    const maxExchanges = policy.maxExchanges ?? DEFAULT_AGENT_MAX_EXCHANGES;
    if (!Number.isSafeInteger(maxExchanges) || maxExchanges < 1) throw new Error('Agent maxExchanges must be a positive safe integer');
    const systemPrompt = [...(policy.systemPrompt ?? [])];
    if (systemPrompt.some(segment => typeof segment !== 'string')) throw new Error('Agent systemPrompt must contain strings');
    return Object.freeze({ systemPrompt: Object.freeze(systemPrompt), maxExchanges,
        ...(policy.llmRetry === undefined ? {} : { llmRetry: resolveLlmRetryPolicy(policy.llmRetry) }),
        ...(policy.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: resolveToolTimeoutMs(policy.toolTimeoutMs) }),
    });
}

// Task execution configuration contracts.
// Unified LLM node configuration shared by long-lived Agents and ephemeral
// Flow nodes. Both reference configuration entities (system prompt, tools,
// skills, connection) by id, so editing an entity updates every referrer.

import type { ModelTier } from '@itookit/driver-llm/contracts';
import type { ResponseFormat } from '@itookit/driver-llm/contracts';

/** How an LLM node assembles its conversation history. */
export type HistoryPolicy = 'inherit' | 'none' | 'upstream';
/** How inherited and node-local system prompts are composed. */
export type SystemPromptPolicy = 'inherit' | 'replace' | 'none';

export type { PromptPreset, SystemPromptDefinition } from '@itookit/tools/contracts';

/**
 * How long a scope's entries are kept. This is a *storage* bound, not a retrieval
 * bound: hosts may also drop entries they no longer trust via an explicit watermark.
 */
export interface MemoryRetentionPolicy {
    /** Keep at most this many entries per scope; the most recently updated survive. */
    maxEntriesPerScope?: number;
    /** Drop entries not updated before this epoch-ms watermark (host-owned). */
    before?: number;
}

/** Long-term memory policy (long-lived Agents only; flow nodes do not inherit). */
export interface MemoryPolicy {
    /** Explicit shared authority; absent keeps the existing Session-local store. */
    sharedMemory?: { id: string; incarnation: string };
    namespaceId: string;
    readScopes: string[];
    writeScopes: string[];
    retrievalLimit?: number;
    retention?: MemoryRetentionPolicy;
}

/** Runtime handling when a model response does not satisfy responseFormat. */
export interface OutputValidationPolicy {
    /** Additional repair requests after the first invalid response. */
    retries?: number;
    onInvalid?: 'fail' | 'repair' | 'continue';
}

import type { ContextCompactionPolicy } from '@itookit/llm-context';
export type { ContextCompactionPolicy } from '@itookit/llm-context';

/**
 * Unified node configuration: reference configuration entities by id plus
 * inline additions/overrides. Resolved at run time (see design doc §3).
 */
export interface LlmNodeConfig {
    // ── References to configuration entities (edit once, applies everywhere) ──
    /** Reference a System Prompt library entry. */
    systemPromptId?: string;
    /** Directly reference tools (tools are standalone entities; no ToolSet layer). */
    toolIds?: string[];
    /** Reference skills (progressive disclosure / static load). */
    skillIds?: string[];
    /** Reference MCP profiles. */
    mcpProfileIds?: string[];
    /** Reference a connection. */
    connectionId?: string;

    // ── Inline additions (appended after referenced content) ──
    /** Node task instructions, appended as extra system segments. */
    systemPrompt?: string[];

    // ── Model ──
    modelTier?: ModelTier;
    modelName?: string;
    temperature?: number;
    thinking?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    maxTokens?: number;
    stream?: boolean;
    webSearch?: boolean;
    /** Provider-independent structured response contract. */
    responseFormat?: ResponseFormat;
    outputValidation?: OutputValidationPolicy;
    contextCompaction?: ContextCompactionPolicy;

    // ── Execution policy ──
    maxExchanges?: number;
    toolTimeoutMs?: number;
    llmRetry?: import('./execution-policy').LlmRetryPolicy;
    /** Per LLM request timeout. */
    timeoutMs?: number;
    approval?: 'none' | 'external' | 'all';
    historyPolicy?: HistoryPolicy;
    systemPromptPolicy?: SystemPromptPolicy;
    persistOutput?: boolean;
    recordToolCalls?: boolean;
    recordThinking?: boolean;
    workingDirectory?: string;

    // ── Memory (long-lived Agents only) ──
    memoryPolicy?: MemoryPolicy;
}

/** Direct task execution mode selected by the host. */
export type ChatExecutionMode = 'chat' | 'agent';

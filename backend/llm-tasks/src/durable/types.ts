import type { ChatMessage, ToolCall, ToolDefinition } from '@itookit/llm-context';
import type { OutputValidationPolicy } from '../contracts';
import type { ResponseFormat, TokenUsage } from '@itookit/driver-llm/contracts';
import type { JsonValue } from '@itookit/durable-kernel';

export interface DurableDependencyBinding {
    taskId: string;
    input: string;
    output?: string;
    edgeId?: string;
    injectOutput?: boolean;
}

export interface DurableProgramInput {
    sessionId: string;
    roundId: string;
    messages: ChatMessage[];
    connectionId: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    /** Additional attempts per LLM exchange; default 3, configured by the host. */
    llmRetry?: import('../contracts').LlmRetryPolicy;
    thinking?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    /** stream !== false → LLM streams (default); false → non-streaming fallback. */
    stream?: boolean;
    /** 走底层内置 server-side search（如 DeepSeek/OpenAI Responses 的 web_search、Gemini 的 googleSearch）。 */
    webSearch?: boolean;
    responseFormat?: ResponseFormat;
    outputValidation?: OutputValidationPolicy;
    contextCompaction?: import('@itookit/llm-context').ContextCompactionPolicy;
    dependencyBindings?: DurableDependencyBinding[];
    /** False keeps scheduling dependencies but does not append their outputs to messages. */
    includeDependencyOutputs?: boolean;
}

export interface DurableAgentInput extends DurableProgramInput {
    /** Host-resolved memory authority frozen at submission; absence grants no memory access. */
    memoryPolicy?: import('../contracts').MemoryPolicy;
    /**
     * Skill snapshots activated when the Task was created (initial Skill selection). They
     * behave exactly like runtime `load_skill` results: their critical rules are re-injected
     * every round and their tool definitions are exposed within `allowedToolIds` only.
     */
    skillContexts?: Array<NonNullable<import('@itookit/tools/contracts').ToolInvokeResult['skillContext']>>;
    maxExchanges?: number;
    toolTimeoutMs?: number;
    workingDirectory?: string;
    approval?: 'none' | 'external' | 'all';
    tools?: ToolDefinition[];
    /** Explicit capability IDs; dynamically loaded definitions must belong to this set. */
    allowedToolIds?: string[];
    externalToolIds?: string[];
    /** Tool name that, when called, declares sub-task payloads (completes the node). */
    subtaskTool?: string;
}

export interface DurableCapabilitySignal {
    llmHandleId: string;
    toolHandleId?: string;
}

export interface DurableChatOutput {
    message: ChatMessage;
    usage: TokenUsage;
    finishReason?: string | null;
}

export interface DurableAgentOutput extends DurableChatOutput {
    outputs?: { result: { content: import('@itookit/durable-kernel').JsonValue; type: 'json' } };
    exchanges: number;
}

export interface DurableAgentState {
    /** Successful Skill-load snapshots, independent of prunable tool messages. */
    skillContexts?: Array<NonNullable<import('@itookit/tools/contracts').ToolInvokeResult['skillContext']>>;
    input: DurableAgentInput;
    phase: 'collecting' | 'llm' | 'approval' | 'tool' | 'human';
    messages: ChatMessage[];
    dependencyOutputs: Record<string, JsonValue>;
    resolvedDependencyIds: string[];
    capabilities?: DurableCapabilitySignal;
    usage: TokenUsage;
    exchanges: number;
    pendingCalls: ToolCall[];
    callIndex: number;
    /**
     * Canonical approval keys for the current assistant batch:
     * roundId, exchange, call id, tool name and args fingerprint.
     */
    approvedCallKeys?: string[];
    /** 2 = exchange-scoped approval interaction IDs; missing = legacy call.id protocol. */
    approvalProtocol?: number;
    /** Persisted interaction ID the reducer is waiting for in approval phase. */
    pendingApprovalInteractionId?: string;
    outputValidationAttempts: number;
}

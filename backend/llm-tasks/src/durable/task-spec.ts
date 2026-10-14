// @file: llm-runtime/src/durable/task-spec.ts
// LLM TaskSpec 构造：统一 llm.agent / llm.chat 的 input 装配。
// 消除 llm-conversation（directTaskSpec）与 builtin-plugins（agentTask）两处重复的
// compact({ sessionId/roundId/messages/model/... }) 模板。

import { resolveLlmRetryPolicy, resolveToolTimeoutMs } from '../contracts';
import type { ChatMessage, ToolDefinition } from '@itookit/llm-context';
import type {
    DurableAgentInput,
    DurableDependencyBinding,
    DurableProgramInput,
} from './types';

export interface LlmTaskInputOptions {
    sessionId: string;
    roundId: string;
    messages: ChatMessage[];
    connectionId?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    llmRetry?: DurableProgramInput['llmRetry'];
    thinking?: boolean;
    reasoningEffort?: DurableProgramInput['reasoningEffort'];
    webSearch?: boolean;
    stream?: boolean;
    responseFormat?: DurableProgramInput['responseFormat'];
    outputValidation?: DurableProgramInput['outputValidation'];
    contextCompaction?: DurableProgramInput['contextCompaction'];
    maxExchanges?: number;
    toolTimeoutMs?: number;
    workingDirectory?: string;
    approval?: DurableAgentInput['approval'];
    tools?: ToolDefinition[];
    allowedToolIds?: string[];
    externalToolIds?: string[];
    /** Initial Skill activation snapshots; the host resolves them before submission. */
    skillContexts?: DurableAgentInput['skillContexts'];
    memoryPolicy?: DurableAgentInput['memoryPolicy'];
    subtaskTool?: string;
    dependencyBindings?: DurableDependencyBinding[];
    includeDependencyOutputs?: boolean;
}

/** 装配 llm.agent / llm.chat 的 program input（去掉 undefined 字段，补 connectionId/approval 默认）。 */
export function buildLlmTaskInput(options: LlmTaskInputOptions): DurableAgentInput {
    return omitUndefined({
        sessionId: options.sessionId,
        roundId: options.roundId,
        messages: options.messages,
        connectionId: options.connectionId ?? 'default',
        model: options.model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs,
        llmRetry: options.llmRetry === undefined ? undefined : resolveLlmRetryPolicy(options.llmRetry),
        thinking: options.thinking,
        reasoningEffort: options.reasoningEffort,
        webSearch: options.webSearch,
        stream: options.stream,
        responseFormat: options.responseFormat,
        outputValidation: options.outputValidation,
        contextCompaction: options.contextCompaction,
        maxExchanges: options.maxExchanges,
        toolTimeoutMs: options.toolTimeoutMs === undefined ? undefined : resolveToolTimeoutMs(options.toolTimeoutMs),
        workingDirectory: options.workingDirectory,
        approval: options.approval ?? 'external',
        tools: options.tools,
        allowedToolIds: options.allowedToolIds,
        externalToolIds: options.externalToolIds,
        skillContexts: options.skillContexts,
        memoryPolicy: freezeMemoryPolicy(options.memoryPolicy),
        subtaskTool: options.subtaskTool,
        dependencyBindings: options.dependencyBindings,
        includeDependencyOutputs: options.includeDependencyOutputs,
    });
}

function freezeMemoryPolicy(policy: DurableAgentInput['memoryPolicy']): DurableAgentInput['memoryPolicy'] {
    if (policy === undefined) return undefined;
    const validName = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
    if (!policy || !validName(policy.namespaceId)
        || ![policy.readScopes, policy.writeScopes].every(scopes => Array.isArray(scopes) && scopes.every(validName))) {
        throw new Error('Invalid task memory policy');
    }
    const limit = policy.retrievalLimit, cap = policy.retention?.maxEntriesPerScope, before = policy.retention?.before;
    if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
        || (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1))
        || (before !== undefined && (!Number.isFinite(before) || before < 0))) throw new Error('Invalid task memory policy limits');
    return structuredClone(policy);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined),
    ) as T;
}

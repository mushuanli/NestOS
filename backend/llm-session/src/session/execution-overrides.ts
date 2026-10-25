import {assertConversationSelection} from '@itookit/kernel-adapters/contracts';
import type {ExecutionOverrides, ExecutorConfig, TaskInput} from '../core/types';

/** A native selection must never be silently ignored by a model or Flow execution. */
export function assertContextSelection(input: Pick<TaskInput, 'overrides' | 'sendIntent'>, identity: ExecutorConfig): void {
    assertPromptAppend(input.overrides?.systemPromptAppend);
    const selection = input.overrides?.harnessConversation;
    if (selection === undefined) return;
    if (identity.execution?.kind !== 'harness' || input.sendIntent?.execution.kind === 'flow')
        throw invalid('CONTEXT_TARGET_NOT_HARNESS');
    assertConversationSelection(selection);
    if (selection.mode === 'continue') throw invalid('CONTEXT_NATIVE_WRITE_UNSUPPORTED');
}

export function applyHarnessOverrides(config: ExecutorConfig, input: Pick<TaskInput, 'overrides' | 'sendIntent'>): ExecutorConfig {
    assertContextSelection(input, config);
    return appendSystemPrompt(config, input.overrides?.systemPromptAppend);
}

export function applyOverrides(config: ExecutorConfig, overrides: ExecutionOverrides): ExecutorConfig {
    if (overrides.harnessConversation !== undefined) throw invalid('CONTEXT_TARGET_NOT_HARNESS');
    const updated = appendSystemPrompt(config, overrides.systemPromptAppend);
    if (overrides.connectionId) updated.connectionId = overrides.connectionId;
    if (overrides.temperature !== undefined) updated.temperature = overrides.temperature;
    if (overrides.streamMode !== undefined) updated.stream = overrides.streamMode;
    if (overrides.reasoningEffort) updated.reasoningEffort = overrides.reasoningEffort;
    if (overrides.thinkingEnabled !== undefined) updated.enableThinking = overrides.thinkingEnabled;
    if (overrides.webSearchEnabled === false) updated.webSearchMode = 'disabled';
    return updated;
}

function appendSystemPrompt(config: ExecutorConfig, append?: string): ExecutorConfig {
    assertPromptAppend(append);
    const base = config.systemPrompt ?? [];
    const systemPrompt = typeof base === 'string' ? [base] : [...base];
    return {...config, ...(append ? {systemPrompt: [...systemPrompt, append]} : {})};
}
function assertPromptAppend(append: unknown): void {
    if (append !== undefined && typeof append !== 'string') throw invalid('CONTEXT_POLICY_OVERRIDE_INVALID');
}
function invalid(code: string): Error {return Object.assign(new Error('Execution context override is not supported'), {code});}

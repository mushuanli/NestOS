import type { ChatMessage } from '../domain/message';
import type { ContextCompactionPolicy } from '../domain/policy';

export function validateContextCompaction(policy?: ContextCompactionPolicy): void {
    if (!policy) return;
    for (const value of [policy.maxMessages, policy.keepRecent ?? 1, policy.maxInputTokens ?? 1,
        policy.summaryTokens ?? 1, policy.maxToolOutputBytes ?? 1024]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('Context compaction limits must be positive safe integers');
    }
    if (policy.maxToolOutputBytes !== undefined && policy.maxToolOutputBytes < 1024) throw new Error('Tool output budget must be at least 1024 bytes');
    if (policy.strategy && !['prune', 'summary-tail', 'checkpoint-reset'].includes(policy.strategy)) throw new Error('Unknown context strategy');
}

/** Prune history without splitting tool exchanges or discarding policy messages. */
export function compactMessages(messages: ChatMessage[], policy?: ContextCompactionPolicy): ChatMessage[] {
    validateContextCompaction(policy);
    if (!policy || messages.length <= policy.maxMessages) return messages;
    const recent = Math.min(policy.maxMessages, policy.keepRecent ?? Math.ceil(policy.maxMessages / 2));
    const keep = new Set<number>();
    let lastUser = -1;
    messages.forEach((message, index) => {
        if (message.role === 'system' || message.role === 'developer' || message.tags?.includes('context-objective') || index >= messages.length - recent) keep.add(index);
        if (message.role === 'user') lastUser = index;
    });
    if (lastUser >= 0) keep.add(lastUser);
    for (let index = 0; index < messages.length; index++) {
        if (messages[index].role !== 'assistant' || !messages[index].tool_calls?.length) continue;
        let end = index + 1;
        while (end < messages.length && messages[end].role === 'tool') end++;
        if (Array.from({ length: end - index }, (_, offset) => index + offset).some(i => keep.has(i))) {
            for (let i = index; i < end; i++) keep.add(i);
        }
        index = end - 1;
    }
    return messages.filter((_message, index) => keep.has(index));
}

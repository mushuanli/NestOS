import type { ChatMessage } from '../domain/message';
import type { ContextCompactionPolicy } from '../domain/policy';
import type { IContextEngine, WindowSelection, ContextEngineOptions, ContextBudget } from '../domain/durable';
import { compactMessages, validateContextCompaction } from './compact-messages';
import { ProviderMessageAdapter } from '../assembly/provider-message-adapter';

export class ContextError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'ContextError'; }
}

/** UTF-8 bytes deliberately overestimate text tokens when no tokenizer is available. */
export function estimateRequestTokens(request: Record<string, unknown>): number {
    return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

export function createContextEngine(options: ContextEngineOptions = {}): IContextEngine {
    const defaults = { maxMessages: 100, keepRecent: 20, maxInputTokens: 64_000, ...options.defaultPolicy };
    validateContextCompaction(defaults);
    const measure = (request: Record<string, unknown>, policy?: ContextCompactionPolicy): ContextBudget => {
        const maxInputTokens = policy?.maxInputTokens ?? defaults.maxInputTokens;
        requirePositive(maxInputTokens);
        const inputTokens = (options.estimateTokens ?? estimateRequestTokens)(request);
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
            throw new ContextError('CONTEXT_INVALID_TOKEN_COUNT', 'Token counter returned an invalid count');
        return { inputTokens, maxInputTokens, estimated: options.estimated ?? true };
    };
    return { measure, select: (messages, request, policy) => select(messages, request, policy ?? defaults, measure) };
}

/** Legacy engines may implement selection only; their budget uses the default counter. */
export function measureContext(engine: IContextEngine, request: Record<string, unknown>, policy?: ContextCompactionPolicy): ContextBudget {
    return engine.measure ? engine.measure(request, policy) : createContextEngine().measure!(request, policy);
}

function select(messages: ChatMessage[], request: Record<string, unknown>, policy: ContextCompactionPolicy, measure: NonNullable<IContextEngine['measure']>): WindowSelection {
    validateContextCompaction(policy);
    new ProviderMessageAdapter().validate(messages);
    let selected = compactMessages(messages, policy);
    let budget = measure({ ...request, messages: selected }, policy);
    while (budget.inputTokens > budget.maxInputTokens) {
        const next = removeOldestGroup(selected);
        if (next.length === selected.length) throw new ContextError('CONTEXT_REQUIRED_INPUT_TOO_LARGE', 'Required context exceeds input budget');
        selected = next;
        budget = measure({ ...request, messages: selected }, policy);
    }
    new ProviderMessageAdapter().validate(selected);
    const included = new Set(selected);
    return { messages: structuredClone(selected), removed: messages.filter(message => !included.has(message)),
        explanation: { strategy: selected.length === messages.length ? 'retain' : 'prune',
            inputTokens: budget.inputTokens, estimated: budget.estimated,
            removedMessages: messages.length - selected.length } };
}

function removeOldestGroup(messages: ChatMessage[]): ChatMessage[] {
    let lastUser = -1;
    messages.forEach((message, index) => { if (message.role === 'user') lastUser = index; });
    const groups: number[][] = [];
    for (let i = 0; i < messages.length; i++) {
        const group = [i];
        if (messages[i].tool_calls?.length) while (messages[i + 1]?.role === 'tool') group.push(++i);
        groups.push(group);
    }
    const group = groups.find(indices => !indices.includes(lastUser) && !indices.includes(messages.length - 1)
        && indices.every(i => !['system', 'developer'].includes(messages[i].role) && !messages[i].tags?.includes('context-objective')));
    return group ? messages.filter((_, index) => !group.includes(index)) : messages;
}

export function requirePositive(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) throw new ContextError('CONTEXT_INVALID_LIMIT', 'Context limit must be a positive safe integer');
}

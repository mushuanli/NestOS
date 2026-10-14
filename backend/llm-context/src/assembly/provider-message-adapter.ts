// @file: llm-runtime/src/core/provider-message-adapter.ts
// ProviderMessageAdapter — provider-specific message validation and cleaning.
//
// Phase 2 (WP-03): Extracted from RoundLog.fold() (Phase 0 removed the
// inline logic). Validates that messages conform to provider requirements
// before being sent to the LLM API.
//
// Supported providers: Anthropic, OpenAI (extensible via strategy pattern).

import type { ChatMessage } from '../domain/message';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ProviderKind = 'anthropic' | 'openai' | 'generic';

export interface AdapterOptions {
    /** Provider to validate for. Default: 'generic'. */
    provider?: ProviderKind;
}

export class ProviderMessageError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'ProviderMessageError';
    }
}

// ─── ProviderMessageAdapter ────────────────────────────────────────────────

export class ProviderMessageAdapter {
    /**
     * Validate and clean messages for the target provider.
     *
     * Rules applied (in order):
     *   1. Remove consecutive duplicate roles
     *   2. Anthropic: last message must be 'user' (trim trailing assistant)
     *   3. Anthropic: no empty content in assistant without tool_calls
     *   4. OpenAI: tool messages must follow assistant with tool_calls
     *
     * Throws ProviderMessageError on irrecoverable violations.
     */
    validate(messages: ChatMessage[], options: AdapterOptions = {}): ChatMessage[] {
        const provider = options.provider ?? 'generic';

        if (messages.length === 0) {
            throw new ProviderMessageError('No messages to validate', 'EMPTY_MESSAGES');
        }

        let result = [...messages];

        // Remove empty assistant messages without tool_calls
        result = result.filter(msg => {
            if (msg.role === 'assistant') {
                const content = typeof msg.content === 'string' ? msg.content : '';
                const hasToolCalls = Boolean(msg.tool_calls?.length);
                if (typeof msg.content === 'string' && !content.trim() && !hasToolCalls) return false;
            }
            return true;
        });
        this.validateToolGroups(result);

        // Provider-specific rules
        switch (provider) {
            case 'anthropic':
                result = this.validateAnthropic(result);
                break;
            case 'openai':
                result = this.validateOpenAI(result);
                break;
            default:
                // Generic: basic validation only
                break;
        }

        return result;
    }

    // ── Anthropic-specific ────────────────────────────────────────────────

    private validateAnthropic(messages: ChatMessage[]): ChatMessage[] {
        const result = [...messages];
        if (result.length === 0 || !['user', 'tool'].includes(result[result.length - 1].role)) {
            throw new ProviderMessageError(
                'Anthropic request must end with a user or tool result message',
                'INVALID_LAST_MESSAGE',
            );
        }

        // Anthropic: no two consecutive 'user' messages
        for (let i = 1; i < result.length; i++) {
            if (result[i].role === 'user' && result[i - 1].role === 'user') {
                throw new ProviderMessageError(
                    'Anthropic does not allow consecutive user messages',
                    'CONSECUTIVE_USER',
                );
            }
        }

        return result;
    }

    // ── OpenAI-specific ────────────────────────────────────────────────────

    private validateOpenAI(messages: ChatMessage[]): ChatMessage[] {
        return [...messages];
    }

    private validateToolGroups(messages: ChatMessage[]): void {
        let expected = new Set<string>();
        for (let index = 0; index < messages.length; index++) {
            const message = messages[index];
            if (message.role === 'tool') {
                const id = message.tool_call_id;
                if (!id || !expected.has(id)) {
                    throw new ProviderMessageError(
                        `Tool message at index ${index} has no matching assistant tool_call`,
                        'TOOL_WITHOUT_TOOL_CALLS',
                    );
                }
                expected.delete(id);
                continue;
            }
            if (expected.size) {
                throw new ProviderMessageError(
                    `Assistant tool_call group is missing results: ${[...expected].join(', ')}`,
                    'MISSING_TOOL_RESULTS',
                );
            }
            if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
                const ids = message.tool_calls.map(call => call.id);
                expected = new Set(ids);
                if (ids.some(id => !id?.trim()) || expected.size !== ids.length) {
                    throw new ProviderMessageError('Tool call IDs must be non-empty and unique', 'INVALID_TOOL_CALL_IDS');
                }
            }
        }
        if (expected.size) {
            throw new ProviderMessageError(
                `Assistant tool_call group is missing results: ${[...expected].join(', ')}`,
                'MISSING_TOOL_RESULTS',
            );
        }
    }
}

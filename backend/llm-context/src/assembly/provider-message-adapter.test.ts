import { describe, expect, it } from 'vitest';
import { ProviderMessageAdapter } from './provider-message-adapter';

describe('ProviderMessageAdapter', () => {
    it('keeps a complete multi-tool protocol group intact', () => {
        const messages = [
            { role: 'user' as const, content: 'work' },
            { role: 'assistant' as const, content: '', tool_calls: [{ id: 'one' }, { id: 'two' }] },
            { role: 'tool' as const, content: '1', tool_call_id: 'one' },
            { role: 'tool' as const, content: '2', tool_call_id: 'two' },
            { role: 'assistant' as const, content: 'done' },
            { role: 'user' as const, content: 'next' },
        ];
        expect(new ProviderMessageAdapter().validate(messages, { provider: 'openai' })).toEqual(messages);
    });

    it('rejects orphaned or incomplete tool results for every provider', () => {
        const adapter = new ProviderMessageAdapter();
        expect(() => adapter.validate([{ role: 'tool', content: 'orphan', tool_call_id: 'x' }]))
            .toThrow(/no matching/);
        expect(() => adapter.validate([
            { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] },
            { role: 'user', content: 'next' },
        ])).toThrow(/missing results/);
    });

    it('does not silently trim a trailing assistant for Anthropic', () => {
        expect(() => new ProviderMessageAdapter().validate([
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answer' },
        ], { provider: 'anthropic' })).toThrow(/user or tool/);
    });
});

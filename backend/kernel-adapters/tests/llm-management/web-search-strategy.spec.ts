import { describe, it, expect } from 'vitest';
import { resolveWebSearchStrategy } from '@itookit/kernel-adapters/contracts';

describe('resolveWebSearchStrategy (web search 三态策略)', () => {
    it('uses builtin server-side search when provider supports it', () => {
        expect(resolveWebSearchStrategy({ serverSideWebSearch: true })).toBe('builtin');
    });

    it('falls back to client tool when provider has no builtin search', () => {
        expect(resolveWebSearchStrategy({ serverSideWebSearch: false })).toBe('client-tool');
    });

    it('treats undefined serverSideWebSearch as no builtin capability (client tool)', () => {
        expect(resolveWebSearchStrategy(undefined)).toBe('client-tool');
    });

    it('disables when the user toggle is off', () => {
        expect(resolveWebSearchStrategy({ serverSideWebSearch: true }, false)).toBe('disabled');
    });

    it('uses builtin only on the protocol that supports it (openai-responses)', () => {
        expect(resolveWebSearchStrategy({ serverSideWebSearch: true }, true, 'openai-responses')).toBe('builtin');
    });

    it('falls back to client tool on a protocol without builtin search (openai-chat)', () => {
        expect(resolveWebSearchStrategy({ serverSideWebSearch: true }, true, 'openai-chat')).toBe('client-tool');
    });
});

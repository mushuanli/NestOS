import { describe, expect, it } from 'vitest';
import { extractionEnd, TWIN_CHUNK_CHARACTERS as size } from '../src/digital-twin/chunking';

describe('digital twin semantic chunks', () => {
    it('allows 32K and preserves every character across oversized blocks', () => {
        const text = 'a'.repeat(size - 1) + '😀' + 'b'.repeat(size + 100);
        const chunks: string[] = []; let offset = 0;
        while (offset < text.length) {
            const end = extractionEnd(text, offset);
            expect(end).toBeGreaterThan(offset); expect(end - offset).toBeLessThanOrEqual(size);
            chunks.push(text.slice(offset, end)); offset = end;
        }
        expect(chunks[0]).toHaveLength(size - 1);
        expect(chunks.join('')).toBe(text);
    });
    it('keeps harness user and assistant messages in the same turn', () => {
        const messages = [
            { turn: '1', role: 'user', content: 'a'.repeat(9000) },
            { turn: '1', role: 'assistant', content: 'b'.repeat(9000) },
            { turn: '2', role: 'user', content: 'c'.repeat(9000) },
            { turn: '2', role: 'assistant', content: 'd'.repeat(9000) },
        ];
        const text = JSON.stringify(messages), end = extractionEnd(text, 0);
        expect(end).toBe(1 + messages.slice(0, 2).map(item => JSON.stringify(item)).join(',').length);
        expect(text.slice(end)).toContain('"turn":"2"');
    });
    it('uses complete native round boundaries despite escaped quotes and braces', () => {
        const round = JSON.stringify({ input: [{ role: 'user', content: '" } \\'.repeat(2000) }], output: [] });
        const text = [round, round, round].join('\n');
        expect(extractionEnd(text, 0)).toBe(round.length * 2 + 1);
    });
    it('falls back to message boundaries when a turn is oversized', () => {
        const first = JSON.stringify({ turn: '1', role: 'user', content: 'a'.repeat(20000) });
        const second = JSON.stringify({ turn: '1', role: 'assistant', content: 'b'.repeat(20000) });
        expect(extractionEnd(`[${first},${second}]`, 0)).toBe(first.length + 1);
    });
    it('keeps paragraphs and fenced code blocks whole when they fit individually', () => {
        const intro = 'a'.repeat(20000) + '\n\n';
        const code = '```ts\n' + 'b'.repeat(20000) + '\n\nconst end = true;\n```\n';
        const text = intro + code + 'c'.repeat(20000);
        const first = extractionEnd(text, 0);
        expect(first).toBe(intro.length - 1);
        const second = extractionEnd(text, first);
        expect(second).toBe(intro.length + code.length);
    });
});

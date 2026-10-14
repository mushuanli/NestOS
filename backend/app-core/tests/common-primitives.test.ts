import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sha256Bytes, sha256Hex, sha256HexSync, simpleHash } from '@itookit/common';
import { sha256HexSync as contextDigest, simpleHash as contextFingerprint } from '@itookit/llm-context';

describe('independent common primitives', () => {
    it('keeps persisted digests stable across common, context and standard SHA-256', () => {
        for (const text of ['', 'abc', '中文🙂', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(1024)]) {
            const expected = createHash('sha256').update(text).digest('hex');
            expect(sha256HexSync(text)).toBe(expected);
            expect(contextDigest(text)).toBe(expected);
            expect(Buffer.from(sha256Bytes(text)).toString('hex')).toBe(expected);
            expect(simpleHash(text)).toBe(contextFingerprint(text));
        }
    });

    it('hashes only the selected bytes when WebCrypto is missing or fails', async () => {
        const bytes = new Uint8Array([0, 97, 98, 99, 0]);
        const slice = new DataView(bytes.buffer, 1, 3);
        const expected = createHash('sha256').update('abc').digest('hex');
        expect(sha256HexSync(slice)).toBe(expected);
        try {
            vi.stubGlobal('crypto', undefined);
            expect(await sha256Hex(slice)).toBe(expected);
            vi.stubGlobal('crypto', { subtle: { digest: async () => { throw new Error('unavailable'); } } });
            expect(await sha256Hex(slice)).toBe(expected);
        } finally { vi.unstubAllGlobals(); }
    });
});

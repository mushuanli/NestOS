import { describe, expect, it } from 'vitest';
import { normalizePtyChunk } from './node-pty-driver';

describe('normalizePtyChunk', () => {
    it('converts CRLF to LF', () => {
        expect(normalizePtyChunk('', 'hello\r\nworld\r\n')).toEqual({ text: 'hello\nworld\n', carry: '' });
    });

    it('converts a lone CR to LF', () => {
        expect(normalizePtyChunk('', 'a\rb')).toEqual({ text: 'a\nb', carry: '' });
    });

    it('carries a trailing CR across chunk boundaries to collapse a split CRLF', () => {
        expect(normalizePtyChunk('', 'hello\r')).toEqual({ text: 'hello', carry: '\r' });
        expect(normalizePtyChunk('\r', '\nworld')).toEqual({ text: '\nworld', carry: '' });
    });

    it('passes through clean LF output unchanged', () => {
        expect(normalizePtyChunk('', 'plain\n')).toEqual({ text: 'plain\n', carry: '' });
    });
});

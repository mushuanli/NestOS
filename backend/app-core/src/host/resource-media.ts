import {FSError} from '@itookit/vfs-core';
import type {ResourceMediaContent} from '@itookit/app-contracts';

type Media = Pick<ResourceMediaContent, 'kind' | 'mimeType' | 'text'>;
/** Signatures take precedence over text decoding and untrusted filename extensions. */
export function classifyResourceBytes(bytes: Uint8Array): Media {
    const mimeType = signatureMime(bytes);
    if (mimeType) return {kind: mimeType.startsWith('image/') ? 'image' : 'file', mimeType};
    try {return {kind: 'text', mimeType: 'text/plain', text: decodeResourceText(bytes)};}
    catch {return {kind: 'file', mimeType: 'application/octet-stream'};}
}
export function decodeResourceText(bytes: Uint8Array): string {
    try {
        const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
        if (/\x00/.test(text)) throw new Error('Binary content');
        return text;
    } catch {throw new FSError('EINVAL', 'Referenced file is not UTF-8 text; use a compatible image or file parameter');}
}
function signatureMime(bytes: Uint8Array): string | undefined {
    const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
    const ascii = (offset: number, value: string) => [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
    if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
    if (ascii(0, '%PDF-')) return 'application/pdf';
    if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
    return undefined;
}

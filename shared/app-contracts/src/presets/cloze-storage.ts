import { normalizeVirtualPath } from '@itookit/vfs-core';

/** One lazy-created file within the notes navigation filesystem. */
export const CLOZE_SRS_PATH = '/.nestos/cloze-srs.seq';
export const CLOZE_DOCUMENT_KEY = '$document';
export interface ClozeDocumentRecord {v: 1; count: number; digest: string; updatedAt: number}

/** Encoding keeps document paths and plugin keys unambiguous, including '#' and '%'. */
export function clozeDocumentPrefix(path: string): string {
    return `${encodeURIComponent(normalizeVirtualPath(path))}#`;
}

export function parseClozeStorageKey(key: string): { path: string; key: string } | undefined {
    const split = key.indexOf('#');
    if (split < 0) return undefined;
    try { return { path: decodeURIComponent(key.slice(0, split)), key: key.slice(split + 1) }; }
    catch { return undefined; }
}

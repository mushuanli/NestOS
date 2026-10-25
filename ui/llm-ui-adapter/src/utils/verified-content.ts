import {sha256Hex} from '@itookit/common';

export interface VerifiedContentOptions {maxBytes: number; previewBytes?: number; signal: AbortSignal;}
export interface VerifiedContentIdentity {bytes: number; sha256: string}
export interface VerifiedContentPage {data: ArrayBuffer; nextOffset?: number}
type ContentReader = (offset: number, limit: number) => Promise<VerifiedContentPage>;

/** Result sources provide their own scoped page validation; byte assembly and integrity are shared. */
export async function readVerifiedContent(identity: VerifiedContentIdentity, read: ContentReader, options: VerifiedContentOptions) {
    const target = readTarget(identity, options), chunks = await readChunks(read, identity.bytes, options.signal, target);
    const bytes = new Uint8Array(target); let position = 0;
    for (const chunk of chunks) {bytes.set(chunk, position); position += chunk.length;}
    const truncated = target < identity.bytes;
    if (!truncated && await sha256Hex(bytes) !== identity.sha256) throw failure('ARTIFACT_BINARY_INTEGRITY');
    options.signal.throwIfAborted();
    return {bytes, truncated};
}

async function readChunks(read: ContentReader, total: number, signal: AbortSignal, target: number) {
    const chunks: Uint8Array[] = []; let offset = 0;
    do {
        signal.throwIfAborted();
        const limit = Math.max(1, Math.min(1024 * 1024, target - offset));
        const chunk = await read(offset, limit);
        signal.throwIfAborted(); validateBytes(chunk, total, offset, limit);
        const bytes = new Uint8Array(chunk.data); chunks.push(bytes); offset += bytes.length;
        if (chunk.nextOffset === undefined || offset >= target) break;
    } while (true);
    if (offset !== target) throw failure('ARTIFACT_RESPONSE_INVALID');
    return chunks;
}

function readTarget(artifact: VerifiedContentIdentity, options: VerifiedContentOptions): number {
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !artifact.sha256) throw failure('ARTIFACT_UNAVAILABLE');
    const target = Math.min(artifact.bytes, options.previewBytes ?? artifact.bytes);
    if (!Number.isSafeInteger(target) || target < 0 || target > options.maxBytes) throw failure('ARTIFACT_DOWNLOAD_TOO_LARGE');
    return target;
}

function validateBytes(chunk: VerifiedContentPage, total: number, offset: number, limit: number): void {
    if (!chunk || !(chunk.data instanceof ArrayBuffer)) throw failure('ARTIFACT_RESPONSE_INVALID');
    const end = offset + chunk.data.byteLength, complete = end === total;
    if (chunk.data.byteLength > limit || end > total) throw failure('ARTIFACT_RESPONSE_INVALID');
    if (complete ? chunk.nextOffset !== undefined : chunk.nextOffset !== end || !chunk.data.byteLength) throw failure('ARTIFACT_RESPONSE_INVALID');
}

function failure(code: string): Error {return Object.assign(new Error(code), {code});}

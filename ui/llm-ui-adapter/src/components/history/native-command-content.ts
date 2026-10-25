import {arrayBufferToBase64, base64ToArrayBuffer, sha256Hex} from '@itookit/common';
import type {ConversationCommandOutputRef, ConversationCommandOutputPage, ConversationControls} from '@itookit/ui-common';
import {readVerifiedContent} from '../../utils/verified-content';

export type CommandOutputReader = Pick<ConversationControls, 'readCommandOutput' | 'loadCommandOutput'>;
const fields = ['version', 'epoch', 'requestId', 'bytes', 'sha256', 'mimeType'] as const;

/** Page boundaries stay below the application RPC limit and cancellation stops subsequent reads. */
export async function readNativeCommandContent(reader: CommandOutputReader, id: string, ref: ConversationCommandOutputRef, signal: AbortSignal): Promise<ArrayBuffer> {
    assertSize(ref.bytes); signal.throwIfAborted();
    if (reader.readCommandOutput) {
        const result = await readVerifiedContent(ref, async (offset, desired) => {
            signal.throwIfAborted(); const limit = Math.min(desired, 65536);
            const page = await reader.readCommandOutput!(id, {offset, limit}); signal.throwIfAborted();
            return nativePage(page, ref, offset, limit);
        }, {maxBytes: 8 * 1024 * 1024, signal});
        return result.bytes.buffer;
    }
    if (!reader.loadCommandOutput) throw failure('ECAPABILITY');
    const content = await reader.loadCommandOutput(id, {maxBytes: 8 * 1024 * 1024}); signal.throwIfAborted();
    if (!(content instanceof ArrayBuffer) || content.byteLength !== ref.bytes || await sha256Hex(new Uint8Array(content)) !== ref.sha256)
        throw failure('COMMAND_OUTPUT_INTEGRITY');
    signal.throwIfAborted(); return content;
}

function nativePage(page: ConversationCommandOutputPage, ref: ConversationCommandOutputRef, offset: number, limit: number) {
    if (!page || !page.ref || !fields.every(field => page.ref[field] === ref[field]) || page.offset !== offset) throw failure('COMMAND_OUTPUT_RESPONSE_INVALID');
    const data = decode(page.data), end = offset + data.byteLength;
    if (data.byteLength > limit || end > ref.bytes || page.nextOffset !== (end === ref.bytes ? null : end)) throw failure('COMMAND_OUTPUT_RESPONSE_INVALID');
    return {data, ...(page.nextOffset === null ? {} : {nextOffset: page.nextOffset})};
}
function decode(data: unknown): ArrayBuffer {
    if (typeof data !== 'string' || data.length > 87384 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw failure('COMMAND_OUTPUT_RESPONSE_INVALID');
    try {
        const decoded = base64ToArrayBuffer(data);
        if (arrayBufferToBase64(decoded) !== data) throw failure('COMMAND_OUTPUT_RESPONSE_INVALID');
        return decoded;
    } catch {throw failure('COMMAND_OUTPUT_RESPONSE_INVALID');}
}
function assertSize(bytes: number): void {if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8 * 1024 * 1024) throw failure('COMMAND_OUTPUT_TOO_LARGE');}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}

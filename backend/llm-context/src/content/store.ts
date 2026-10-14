import type { ContentRef, IContextContentStore } from '../domain/durable';
import { sha256Hex } from './digest';
import { ContextError } from '../window/engine';

export interface ImmutableContentPort {
    putIfAbsent(id: string, content: string): Promise<void>;
    get(id: string): Promise<string | null>;
}

export function createContextContentStore(port: ImmutableContentPort): IContextContentStore {
    return {
        async publish(content, mediaType = 'application/json') {
            const sha256 = await sha256Hex(content);
            const ref = { id: sha256, sha256, bytes: new TextEncoder().encode(content).length, mediaType };
            await port.putIfAbsent(ref.id, content);
            await verifyContent(ref, await port.get(ref.id));
            return ref;
        },
        async read(ref) {
            if (!ref || !/^[a-f0-9]{64}$/.test(ref.id) || ref.id !== ref.sha256 || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
                throw new ContextError('CONTEXT_CONTENT_UNAVAILABLE', 'Invalid context content reference');
            }
            return verifyContent(ref, await port.get(ref.id));
        },
    };
}

async function verifyContent(ref: ContentRef, content: string | null): Promise<string> {
    if (content === null || await sha256Hex(content) !== ref.sha256
        || new TextEncoder().encode(content).length !== ref.bytes) {
        throw new ContextError('CONTEXT_CONTENT_UNAVAILABLE', `Context content missing or corrupt: ${ref.id}`);
    }
    return content;
}

export function contextKey(contextId: string, suffix: string): string {
    if (!contextId || contextId.length > 512) throw new ContextError('CONTEXT_INVALID_ID', 'Invalid context identity');
    return `context/${encodeURIComponent(contextId)}/${suffix}`;
}

import type {
    ContentRef, ContextCursor, ContextHistoryPage, ContextHistorySegment, ContextRequestSnapshot,
    ContextServicePorts, IContextReader,
} from '../domain/durable';
import { sha256Hex } from '../content/digest';
import { contextKey } from '../content/store';
import { ContextError, requirePositive } from '../window/engine';

export async function loadRequest(ports: ContextServicePorts, cursor: ContextCursor): Promise<ContextRequestSnapshot> {
    const snapshot = JSON.parse(await ports.content.read(cursor.snapshot)) as ContextRequestSnapshot;
    if (snapshot.schema !== 1 || snapshot.contextId !== cursor.contextId || snapshot.revision !== cursor.revision
        || snapshot.generation !== cursor.generation || await sha256Hex(JSON.stringify(snapshot.request)) !== snapshot.digest) {
        throw new ContextError('CONTEXT_CONTENT_UNAVAILABLE', 'Invalid context request snapshot');
    }
    return snapshot;
}

export function createContextReader(ports: ContextServicePorts): IContextReader {
    const inspect = async (id: string) => {
        const cursor = await ports.records.get(contextKey(id, 'head')) as ContextCursor | undefined;
        return cursor ? loadRequest(ports, cursor) : null;
    };
    return { inspect, history: async (id, options = {}) => {
        const snapshot = await inspect(id);
        if (!snapshot) return { items: [], next: null };
        return readHistory(ports, snapshot.history, options);
    }, read: async (ref, offset = 0, limit = 8192) => {
        requirePositive(limit);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new ContextError('CONTEXT_INVALID_LIMIT', 'Invalid content offset');
        const text = await ports.content.read(ref);
        const end = Math.min(text.length, offset + Math.min(limit, 32_768));
        return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
    } };
}

async function readHistory(ports: ContextServicePorts, head: ContentRef, options: Parameters<IContextReader['history']>[1] = {}): Promise<ContextHistoryPage> {
    const limit = Math.min(options.limit ?? 20, 100);
    const maxBytes = Math.min(options.maxBytes ?? 16_384, 65_536);
    requirePositive(limit); requirePositive(maxBytes);
    let segment: ContentRef | null = options.cursor?.segment ?? head;
    let offset = options.cursor?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ContextError('CONTEXT_INVALID_LIMIT', 'Invalid history cursor');
    const items: ContextHistoryPage['items'] = [];
    let bytes = 0;
    for (let scanned = 0; segment && scanned < 100; scanned++) {
        const page = JSON.parse(await ports.content.read(segment)) as ContextHistorySegment;
        for (; offset < page.messages.length; offset++) {
            const message = page.messages[offset];
            if (options.query && !JSON.stringify(message).includes(options.query)) continue;
            const preview = JSON.stringify(message).slice(0, Math.max(1, Math.floor(maxBytes / 4)));
            if (items.length && (items.length >= limit || bytes + new TextEncoder().encode(preview).length > maxBytes)) return { items, next: { segment, offset } };
            const rendered = preview.length < JSON.stringify(message).length ? { role: message.role, content: `${preview}\n[truncated]` } : message;
            items.push({ id: page.id, index: offset, message: rendered });
            bytes += new TextEncoder().encode(preview).length;
        }
        segment = page.previous; offset = 0;
    }
    return { items, next: segment ? { segment, offset } : null };
}

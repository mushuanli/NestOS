import { FSError, type FSNode } from '@itookit/vfs-core';
import { mapConcurrent } from '../utils/map-concurrent';

export interface ConversationSource {
    id: string;
    cursorAfter?(node: FSNode): string;
    read(cursor?: string): Promise<{nodes: FSNode[]; nextCursor?: string}>;
}
interface Position { cursor?: string; offset: number; done?: boolean }
interface Buffer { source: ConversationSource; position: Position; nodes?: FSNode[]; nextCursor?: string; failed?: boolean; last?: FSNode }

export function compareConversations(a: FSNode, b: FSNode): number {
    return b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path);
}
export function localConversationSource(nodes: FSNode[]): ConversationSource {
    return {id: '@mindos', cursorAfter: node => JSON.stringify([node.modifiedAt, node.path]), read: async cursor => {
        if (!cursor) return {nodes};
        let after: unknown;
        try {after = JSON.parse(cursor);} catch {throw new FSError('EINVAL', 'Invalid local conversation cursor');}
        if (!Array.isArray(after) || after.length !== 2 || !Number.isFinite(after[0]) || typeof after[1] !== 'string')
            throw new FSError('EINVAL', 'Invalid local conversation position');
        const [time, path] = after as [number, string];
        return {nodes: nodes.filter(node => node.modifiedAt < time || node.modifiedAt === time && node.path.localeCompare(path) > 0)};
    }};
}

function positions(cursor?: string): Record<string, Position> {
    if (!cursor) return {};
    let value: unknown;
    try { value = JSON.parse(cursor); } catch { throw new FSError('EINVAL', 'Invalid conversation cursor'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FSError('EINVAL', 'Invalid conversation cursor');
    for (const entry of Object.values(value)) {
        if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.offset) || entry.offset < 0
            || entry.cursor !== undefined && typeof entry.cursor !== 'string' || entry.done !== undefined && typeof entry.done !== 'boolean')
            throw new FSError('EINVAL', 'Invalid conversation source position');
    }
    return value as Record<string, Position>;
}

async function peek(buffer: Buffer): Promise<FSNode | undefined> {
    if (buffer.failed || buffer.position.done) return;
    for (let emptyPages = 0; emptyPages < 8; emptyPages++) {
        if (!buffer.nodes) {
            const page = await buffer.source.read(buffer.position.cursor);
            buffer.nodes = [...page.nodes].sort(compareConversations); buffer.nextCursor = page.nextCursor;
        }
        const node = buffer.nodes[buffer.position.offset];
        if (node) return node;
        if (!buffer.nextCursor) { buffer.position.done = true; return; }
        if (buffer.nextCursor === buffer.position.cursor) throw new FSError('EIO', 'Conversation cursor did not advance');
        buffer.position = {cursor: buffer.nextCursor, offset: 0}; buffer.nodes = undefined;
    }
    throw new FSError('EIO', 'Too many empty conversation pages');
}

/** Merge only enough source pages to produce the requested window and its continuation. */
export async function readConversationPage(sources: ConversationSource[], cursor: string | undefined, limit: number) {
    const saved = positions(cursor), errors: Array<{source: string; error: unknown}> = [];
    const buffers: Buffer[] = sources.map(source => ({source, position: saved[source.id] ?? {offset: 0}}));
    const heads = async () => mapConcurrent(buffers, 4, async buffer => {
        try { return await peek(buffer); }
        catch (error) { buffer.failed = true; errors.push({source: buffer.source.id, error}); return undefined; }
    });
    const nodes: FSNode[] = [];
    let candidates = await heads();
    while (nodes.length < limit) {
        const next = candidates.flatMap((node, index) => node ? [{node, index}] : []).sort((a, b) => compareConversations(a.node, b.node))[0];
        if (!next) break;
        nodes.push(next.node); buffers[next.index]!.position.offset++; buffers[next.index]!.last = next.node;
        candidates = await heads();
    }
    const hasMore = candidates.some(Boolean);
    return {nodes, errors, hasMore, cursor: hasMore ? JSON.stringify(Object.fromEntries(buffers.map(buffer => [buffer.source.id,
        buffer.last && buffer.source.cursorAfter ? {cursor: buffer.source.cursorAfter(buffer.last), offset: 0} : buffer.position]))) : undefined};
}

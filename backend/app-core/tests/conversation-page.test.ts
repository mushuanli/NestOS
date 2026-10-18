import { expect, it, vi } from 'vitest';
import type { FSNode } from '@itookit/vfs-core';
import { localConversationSource, readConversationPage, type ConversationSource } from '../src/projects/conversation-page';

const node = (id: string, modifiedAt: number) => ({path: '/' + id, modifiedAt}) as FSNode;
function source(id: string, times: number[], size = 4) {
    const read = vi.fn(async (cursor?: string) => {
        const start = Number(cursor ?? 0), end = start + size;
        return {nodes: times.slice(start, end).map(time => node(`${id}-${time}`, time)), nextCursor: end < times.length ? String(end) : undefined};
    });
    return {id, read};
}

it('merges sources into bounded recent pages with no lost or repeated rows across continuations', async () => {
    const a = source('a', [30, 27, 24, 21, 18, 15]), b = source('b', [29, 26, 23, 20, 17, 14]);
    const c = source('mindos', [28, 25, 22, 19, 16, 13]);
    const first = await readConversationPage([a, b, c], undefined, 15);
    expect(first.nodes.map(row => row.modifiedAt)).toEqual(Array.from({length: 15}, (_, i) => 30 - i));
    expect(first.hasMore).toBe(true); expect(first.errors).toEqual([]);
    const second = await readConversationPage([a, b, c], first.cursor, 15);
    expect(second.nodes.map(row => row.modifiedAt)).toEqual([15, 14, 13]);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.nodes, ...second.nodes].map(row => row.path)).size).toBe(18);
});

it('does not scan older pages just to produce a recent preview', async () => {
    const a = source('a', Array.from({length: 1000}, (_, i) => 3000 - i), 50);
    const b = source('b', Array.from({length: 1000}, (_, i) => 1000 - i), 50);
    expect((await readConversationPage([a, b], undefined, 15)).nodes).toHaveLength(15);
    expect(a.read).toHaveBeenCalledOnce(); expect(b.read).toHaveBeenCalledOnce();
});

it('retains healthy sources when another harness fails, and rejects malformed cursors', async () => {
    const healthy = source('local', [2, 1]), broken: ConversationSource = {id: 'remote', read: async () => {throw new Error('offline');}};
    const page = await readConversationPage([healthy, broken], undefined, 15);
    expect(page.nodes).toHaveLength(2); expect(page.errors).toMatchObject([{source: 'remote'}]);
    for (const cursor of ['[]', '{', '{"local":{"offset":-1}}', '{"local":{"offset":0.1}}'])
        await expect(readConversationPage([healthy], cursor, 15)).rejects.toMatchObject({code: 'EINVAL'});
});

it('stops a provider whose empty pages repeat a cursor', async () => {
    const read = vi.fn(async () => ({nodes: [], nextCursor: 'same'}));
    const page = await readConversationPage([{id: 'loop', read}], undefined, 15);
    expect(page.errors).toHaveLength(1); expect(read).toHaveBeenCalledTimes(2);
});

it('does not shift local continuation rows when a newer conversation arrives', async () => {
    const nodes = Array.from({length: 20}, (_, i) => node('local-' + i, 100 - i));
    const first = await readConversationPage([localConversationSource(nodes)], undefined, 15);
    const second = await readConversationPage([localConversationSource([node('new', 101), ...nodes])], first.cursor, 15);
    expect(second.nodes.map(row => row.path)).toEqual(nodes.slice(15).map(row => row.path));
    expect(second.hasMore).toBe(false);
    expect((await readConversationPage([localConversationSource(nodes.slice(0, 15))], undefined, 15)).hasMore).toBe(false);
});

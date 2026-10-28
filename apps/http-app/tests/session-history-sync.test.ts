import {afterEach, expect, it} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import type {DescriptorPatch, WireValue} from '@itookit/app-transport/rpc';

const peers: RpcPeer[] = [];
afterEach(async () => {await Promise.all(peers.splice(0).map(peer => peer.close()));});
interface State {sessionId: string; messages: {id: string; content: string}[]; view: {manifest: {currentBranch: string}}}
const state = (id: string, content: string, branch = 'main'): State => ({sessionId: id, messages: [{id: 'message', content}], view: {manifest: {currentBranch: branch}}});
async function fixture(initial = state('a', 'a'.repeat(600000))) {
    let snapshot = initial, changed = (_event?: unknown) => {};
    const source = {getSnapshot: () => structuredClone(snapshot), getSessions: () => [],
        onGlobalEvent: (listener: typeof changed) => {changed = listener; return () => {changed = () => {};};}};
    const server = new RpcPeer('server', async () => ({})), client = new RpcPeer('client', call => server.handle(call));
    peers.push(server, client);
    const boot = await server.bootstrap(source); client.applyUpdates(boot.updates);
    const root = client.decode(boot.value!) as typeof source;
    const update = async (next: State, notify = true) => {
        snapshot = next; if (notify) changed(); else server.invalidate('session');
        const updates = await server.refresh(); client.applyUpdates(updates); await client.waitUpdates(updates);
        expect(root.getSnapshot()).toEqual(next); return updates;
    };
    return {server, client, root, update};
}
it('reuses the loaded A history across A → B → A and preserves immutable row identity', async () => {
    const a = state('a', 'a'.repeat(600000)), f = await fixture(a), loaded = f.root.getSnapshot().messages[0];
    await f.update(state('b', 'b'.repeat(600000)));
    const updates = await f.update(structuredClone(a));
    expect(JSON.stringify(updates).length).toBeLessThan(2048);
    expect(f.root.getSnapshot().messages[0]).toBe(loaded);
});
it('compares returning A against its own history and sends only small changes made while away', async () => {
    const a = state('a', 'a'.repeat(600000)), f = await fixture(a);
    await f.update(state('b', 'b'.repeat(600000)));
    const changed = structuredClone(a); changed.messages[0].content += ' background addition';
    const updates = await f.update(changed);
    expect(JSON.stringify(updates).length).toBeLessThan(2048);
    expect(JSON.stringify(updates)).toContain('background addition');
});
it('keeps branches distinct and rereads the source after a branch switch even without an event', async () => {
    const main = state('a', 'main'.repeat(40000)), f = await fixture(main);
    await f.update(state('a', 'review'.repeat(40000), 'review'), false);
    const updates = await f.update(main, false);
    expect(JSON.stringify(updates).length).toBeLessThan(2048);
});
it('syncs a small middle edit or deletion in a large history instead of retransmitting its text', async () => {
    const a = state('a', 'a'.repeat(300000) + 'original middle' + 'z'.repeat(300000)), f = await fixture(a);
    const edited = structuredClone(a); edited.messages[0].content = edited.messages[0].content.replace('original middle', 'edited middle');
    const update = await f.update(edited);
    expect(JSON.stringify(update).length).toBeLessThan(2048); expect(JSON.stringify(update)).toContain('splice');
    edited.messages[0].content = edited.messages[0].content.replace('edited middle', '');
    expect(JSON.stringify(await f.update(edited)).length).toBeLessThan(2048);
});
it('replaces history after a large change instead of emitting a large fine-grained patch', async () => {
    const initial = state('a', 'before'); initial.messages = Array.from({length: 200}, (_, i) => ({id: `m${i}`, content: 'old'}));
    const f = await fixture(initial), next = structuredClone(initial);
    for (const row of next.messages) row.content = 'updated'.repeat(100);
    const updates = await f.update(next);
    const patches = updates.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && value.$patch
        ? [(value as unknown as {$patch: DescriptorPatch}).$patch] : []);
    expect(patches.flatMap(patch => patch.changes)).toContainEqual(expect.objectContaining({value: expect.any(Array)}));
});
it('bounds retained histories and safely reloads an evicted Session', async () => {
    const a = state('a', 'a'.repeat(10000)), f = await fixture(a);
    for (let index = 0; index < 9; index++) await f.update(state(`other-${index}`, String(index).repeat(10000)));
    const updates = await f.update(a);
    expect(JSON.stringify(updates).length).toBeGreaterThan(10000);
    const descriptors = (f.client as unknown as {descriptors: Map<string, {snapshots: Record<string, WireValue>}>}).descriptors;
    const encoded = [...descriptors.values()][0].snapshots.getSnapshot as {$object: {histories: {$object: Record<string, WireValue>}}};
    expect(Object.keys(encoded.$object.histories.$object)).toHaveLength(8);
});

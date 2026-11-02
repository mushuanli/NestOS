import {interceptConversationTransactions} from './remote-conversation-faults';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {SessionRepository} from '@itookit/llm-session';
import {ProjectDraftStore} from '../src/projects/drafts/store';
import {ProjectDraftService} from '../src/projects/drafts/service';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanups.push(() => manager.dispose());
    const fault = interceptConversationTransactions(await manager.openFileSystem('/'));
    const fs = fault.fs, repo = new SessionRepository(fs); await repo.init();
    for (const folder of ['/A', '/B', '/C']) await repo.createFolder(folder);
    const service = new ProjectDraftService(id => new ProjectDraftStore(fs, id), repo, async () => ['a', 'b', 'c']);
    const source = await service.open('a', '/A'), target = await service.open('b', '/B');
    return {fs, repo, service, source, target, fault};
}
it('moves text, title and attachment identities together and refreshes both old project views', async () => {
    const f = await fixture(), bytes = new TextEncoder().encode('attachment bytes').buffer;
    const asset = await f.source.attachments.put(bytes), data = JSON.stringify({title: 'My draft', text: 'Keep text', asset});
    await f.source.save(data); await f.source.move!('b');
    const next = (await f.target.refresh!())!;
    expect(next.id).toBe(f.source.id); expect(next.initialData).toBe(data);
    expect(new Uint8Array(await next.attachments.read(asset))).toEqual(new Uint8Array(bytes));
    const former = (await f.source.refresh!())!;
    expect(former.id).not.toBe(f.source.id); expect(former.initialData).toBe('');
    await expect(f.source.save('stale edit')).rejects.toMatchObject({code: 'ECONFLICT'});
    await f.source.move!('b'); expect((await f.service.open('b', '/B')).id).toBe(next.id);
});
it('keeps both drafts intact when the destination is occupied', async () => {
    const f = await fixture(); await f.source.save('source'); await f.target.save('target');
    await expect(f.source.move!('b')).rejects.toMatchObject({code: 'EBUSY'});
    expect((await f.service.open('a', '/A')).initialData).toBe('source');
    expect((await f.service.open('b', '/B')).initialData).toBe('target');
});
it('rejects movement after first submission and keeps the custom title fixed on retry', async () => {
    const f = await fixture(); await f.source.save('text');
    const prepared = await f.source.prepare({title: 'Custom title'});
    expect((await f.repo.getManifest(prepared.sessionId)).title).toBe('Custom title');
    await expect(f.source.move!('b')).rejects.toMatchObject({code: 'EBUSY'});
    await f.source.prepare({title: 'Retry must retain the first title'});
    expect((await f.repo.getManifest(prepared.sessionId)).title).toBe('Custom title');
});
it('reconciles a lost transaction acknowledgement without copying or moving the draft twice', async () => {
    const f = await fixture(); await f.source.save('once');
    const original = f.fault.commit; let lost = false;
    f.fault.transaction.mockImplementation(async run => {
        const result = await original(run);
        if (!lost && await f.fs.meta.seq!.getEntry('/var/lib/projects/a/draft.seq', `move/${f.source.id}/${f.source.id}`)) {lost = true; throw new Error('Lost acknowledgement');}
        return result;
    });
    await f.source.move!('b'); expect(lost).toBe(true);
    await f.source.move!('b');
    expect((await f.service.open('b', '/B')).initialData).toBe('once');
    await expect(f.source.move!('c')).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('rejects an old movement receipt after the draft has moved again', async () => {
    const f = await fixture(); await f.source.save('Keep the same identity'); await f.source.move!('b');
    const atB = await f.service.open('b', '/B'); await atB.move!('a');
    await expect(f.source.move!('b')).rejects.toMatchObject({code: 'ECONFLICT'});
    expect((await f.service.open('a', '/A')).initialData).toBe('Keep the same identity');
});

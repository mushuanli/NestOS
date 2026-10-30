import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {CLOZE_SRS_PATH, CLOZE_DOCUMENT_KEY, clozeDocumentPrefix} from '@itookit/app-contracts';
import {studyIndex, STUDY_REFRESH_MS} from '../src/study-index';
import {createStudyHost} from '../src/study';
import {SeqFileStore} from '../src/srs-store';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    cleanups.push(() => manager.dispose());
    await fs.driver.createFile({parentPath: '/', name: 'tracked.md', content: '--alpha--'});
    await fs.driver.createFile({parentPath: '/', name: 'unopened.md', content: '--unopened--'});
    const index = studyIndex(fs), release = index.acquire(); cleanups.push(release);
    return {fs, index, host: createStudyHost(fs, async () => {})};
}
it('does not enumerate or read untracked files and registers counts without grading state', async () => {
    const {fs, index, host} = await fixture();
    const children = vi.spyOn(fs.driver, 'getChildren'), read = vi.spyOn(fs.driver, 'readContent');
    expect(await host.list()).toEqual([]); expect(read).not.toHaveBeenCalled(); expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
    await index.update('/tracked.md', true);
    expect(await host.list()).toEqual([{id: '/tracked.md', title: 'tracked.md', kind: 'document'}]);
    expect(children).not.toHaveBeenCalled(); expect(read.mock.calls.map(call => call[0])).toEqual(['/tracked.md']);
    const record = JSON.parse((await fs.meta.seq!.getEntry(CLOZE_SRS_PATH, clozeDocumentPrefix('/tracked.md') + CLOZE_DOCUMENT_KEY))!);
    expect(record).toMatchObject({v: 1, count: 1}); expect(JSON.stringify(record)).not.toContain('alpha');
    expect(await new SeqFileStore(fs, '/tracked.md').entries('card:')).toEqual([]);
});
it('reuses one progress snapshot across documents and refreshes local grades without remote enumeration', async () => {
    const {fs, index, host} = await fixture(); await index.update('/tracked.md', true);
    const walk = vi.spyOn(fs.driver, 'exists'); const store = host.store('/tracked.md');
    expect(await store.entries!('card:')).toEqual([]); await store.get('_mdx_srs'); await store.entries!('card:');
    expect(walk).not.toHaveBeenCalled();
    const raw = new SeqFileStore(fs, '/tracked.md'); await raw.set('card:one', {reviewCount: 1});
    walk.mockClear(); expect(await store.entries!('card:')).toEqual([['card:one', {reviewCount: 1}]]); expect(walk).not.toHaveBeenCalled();
    await raw.remove('card:one'); expect(await store.entries!('card:')).toEqual([]);
});
it('updates an opened file immediately and defers other tracked files until the five-minute reconciliation', async () => {
    const {fs, index} = await fixture(); await index.update('/tracked.md', true); await index.update('/unopened.md', true);
    const release = index.acquire('/tracked.md'); cleanups.push(release);
    const read = vi.spyOn(fs.driver, 'readContent');
    await fs.driver.writeContent('/tracked.md', '--alpha-- and --beta--');
    await vi.waitFor(async () => expect(JSON.parse((await fs.meta.seq!.getEntry(CLOZE_SRS_PATH, clozeDocumentPrefix('/tracked.md') + CLOZE_DOCUMENT_KEY))!).count).toBe(2));
    expect(read.mock.calls.map(call => call[0])).toEqual(['/tracked.md']); read.mockClear();
    await fs.driver.writeContent('/unopened.md', '--other-- and --second--'); expect(read).not.toHaveBeenCalled();
    await index.reconcile(); expect(read.mock.calls.map(call => call[0])).toEqual(['/unopened.md']);
    expect(STUDY_REFRESH_MS).toBe(300000);
});
it('keeps a formerly tracked zero-cloze document registered and never adopts a new untracked file on reconciliation', async () => {
    const {fs, index, host} = await fixture(); await index.update('/tracked.md', true);
    await fs.driver.writeContent('/tracked.md', 'plain'); await index.reconcile();
    expect(await host.list()).toEqual([]);
    expect(JSON.parse((await fs.meta.seq!.getEntry(CLOZE_SRS_PATH, clozeDocumentPrefix('/tracked.md') + CLOZE_DOCUMENT_KEY))!).count).toBe(0);
    expect(await fs.meta.seq!.getEntry(CLOZE_SRS_PATH, clozeDocumentPrefix('/unopened.md') + CLOZE_DOCUMENT_KEY)).toBeNull();
});
it('defers hidden editors and refreshes externally changed progress without resurrecting local state', async () => {
    const {fs, index, host} = await fixture(); await index.update('/tracked.md', true);
    cleanups.push(index.acquire('/tracked.md', () => false));
    const read = vi.spyOn(fs.driver, 'readContent');
    await fs.driver.writeContent('/tracked.md', '--alpha-- and --beta--');
    expect(read).not.toHaveBeenCalled();
    await index.reconcile(); expect(read.mock.calls.map(call => call[0])).toEqual(['/tracked.md']);
    const raw = new SeqFileStore(fs, '/tracked.md'); await raw.set('card:one', {reviewCount: 1});
    await fs.meta.seq!.deleteEntry(CLOZE_SRS_PATH, clozeDocumentPrefix('/tracked.md') + 'card:one');
    await index.reconcile(); expect(await host.store('/tracked.md').entries!('card:')).toEqual([]);
});
it('reconciles on the five-minute timer without reading unchanged document bodies', async () => {
    vi.useFakeTimers();
    const {fs, index} = await fixture(); await index.update('/tracked.md', true);
    const read = vi.spyOn(fs.driver, 'readContent');
    await fs.driver.writeContent('/tracked.md', '--alpha-- and --beta--');
    await vi.advanceTimersByTimeAsync(STUDY_REFRESH_MS - 1); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await index.list(); expect(read.mock.calls.map(call => call[0])).toEqual(['/tracked.md']);
    read.mockClear(); await vi.advanceTimersByTimeAsync(STUDY_REFRESH_MS); await index.list(); expect(read).not.toHaveBeenCalled();
});

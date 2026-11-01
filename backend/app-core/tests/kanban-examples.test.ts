import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {KanbanExamples} from '../src/presets/kanban-examples';
import demo from '../src/presets/kanban-demo.json';
import {createNestOSKanban} from '../src/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import {UserEventService} from '../src/events/service';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {openApplicationView} from '../src/host';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), events = await UserEventService.open(fs);
    cleanup.push(async () => {events.journal.close();});
    const service = createNestOSKanban({store, actor: {kind: 'human', id: 'admin'}, authorize: async () => {}, log: vi.fn(),
        notifications: {sourceId: 'test:examples', journal: events.journal}});
    const examples = new KanbanExamples(store, service); return {fs, store, service, examples, events};
}
it('atomically seeds a usable tutorial once, including hierarchy, ready work and archived history', async () => {
    const f = await fixture(); await Promise.all([f.examples.seed(), f.examples.seed()]);
    const state = await f.store.read(demo.id); expect(state).not.toBeNull();
    expect(state!.board.items.length + state!.archiveIndex!.length).toBe(demo.items.length);
    expect(state!.board.items.find(item => item.id === 'demo-first-card')?.status).toBe('open');
    expect(state!.board.items.find(item => item.id === 'demo-remote-check')?.planning?.parentId).toBe('demo-remote-feature');
    expect(state!.board.items.some(item => item.status === 'claimed' || item.status === 'review')).toBe(false);
    expect((await f.service.item(demo.id, 'demo-archived')).archive).toBeDefined();
    await f.examples.seed(); expect(await f.store.read(demo.id)).toEqual(state);
    expect(await f.examples.restore('kanban:nestos-demo')).toBe(false);
});
it('only explicit recovery fills missing examples and preserves edits, custom work and archives', async () => {
    const f = await fixture(); await f.examples.seed();
    await f.store.update(demo.id, 'user-edit', 'edit', state => {
        state!.board.title = 'My customized board'; state!.board.items.find(item => item.id === 'demo-guide')!.responsibility = 'User edited guide';
        state!.board.items = state!.board.items.filter(item => item.id !== 'demo-session'); state!.board.revision++; return state!;
    });
    await f.examples.seed(); expect((await f.examples.list())[0].exists).toBe(false);
    let board = await f.service.read(demo.id);
    await f.service.execute(demo.id, {operationId: 'custom', expectedRevision: board.revision, command: {type: 'create-item', item: {id: 'personal', title: 'Personal work', responsibility: 'Mine', acceptance: 'Verified'}}});
    expect(await f.examples.restore('kanban:nestos-demo')).toBe(true); board = await f.service.read(demo.id);
    expect(board.title).toBe('My customized board'); expect(board.items.find(item => item.id === 'demo-guide')?.responsibility).toBe('User edited guide');
    expect(board.items.filter(item => item.id === 'demo-session')).toHaveLength(1); expect(board.items.some(item => item.id === 'personal')).toBe(true);
    expect((await f.service.item(demo.id, 'demo-archived')).archive).toBeDefined(); expect((await f.examples.list())[0].exists).toBe(true);
    expect(await f.examples.restore('kanban:nestos-demo')).toBe(false);
    expect((await f.events.readEvents()).events.some(event => event.value.type === 'kanban.create-item')).toBe(true);
    expect((await f.events.listNotifications()).items).toHaveLength(0);
});
it('rolls back a failed seed so retry cannot leave a partially installed tutorial', async () => {
    const f = await fixture(), update = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementationOnce((id, operation, fingerprint, change) => update(id, operation, fingerprint, state => {
        change(state); throw Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'});
    }));
    await expect(f.examples.seed()).rejects.toThrow('PRIVATE_BODY'); expect(await f.store.read(demo.id)).toBeNull();
    expect(await f.store.events(demo.id, 0, 200, 999)).toEqual([]);
    await f.examples.seed(); expect((await f.examples.list())[0].exists).toBe(true);
});
it('installs at runtime startup and appears in the actual settings recovery capability', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), startupMode: 'interactive', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose()); const view = await openApplicationView(runtime); cleanup.push(() => view.close());
    expect((await runtime.kanban!.list()).some(board => board.id === demo.id)).toBe(true);
    const resources = await view.backend.initialFiles();
    expect((await resources.list()).find(entry => entry.id === 'kanban:nestos-demo')).toMatchObject({group: 'kanban', exists: true});
    expect(await resources.restore(['kanban:nestos-demo'])).toEqual([{id: 'kanban:nestos-demo', status: 'preserved'}]);
});
it('upgrades the earlier demo with context exercises while preserving deleted old examples and edited decisions', async () => {
    const f = await fixture(); await f.examples.seed();
    await f.store.update(demo.id, 'older-installation', 'older', state => {
        delete state!.presetVersions;
        state!.board.items = state!.board.items.filter(item => !['demo-session', 'demo-context', 'demo-review-change', 'demo-scroll'].includes(item.id));
        delete state!.records; state!.board.revision++; return state!;
    });
    await f.fs.meta.seq!.deleteEntry('/kanban/boards.seq', `receipt/${encodeURIComponent(demo.id)}/${encodeURIComponent('preset:kanban-demo:v' + demo.version)}`);
    await f.examples.seed(); const state = (await f.store.read(demo.id))!;
    expect(state.board.items.some(item => item.id === 'demo-session')).toBe(false);
    expect(state.board.items.find(item => item.id === 'demo-context')?.amendments).toHaveLength(1);
    expect(state.records).toHaveLength(3); expect(state.records!.find(record => record.id === 'demo-decision-draft')!.status).toBe('draft');
    expect(state.presetVersions![demo.id]).toBe(demo.version);
});

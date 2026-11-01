import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanCommand} from '@itookit/kanban/contracts';
import {createNestOSKanban} from '../src/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs); let serial = 0;
    const options = {store, actor: {kind: 'human' as const, id: 'admin'}, authorize: async () => {}, log: vi.fn()};
    const service = createNestOSKanban(options);
    await service.create({id: 'board', title: 'Board', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator']}], policy: {requireEstimate: false}});
    const run = async (command: KanbanCommand) => service.execute('board', {operationId: `op-${++serial}`, expectedRevision: (await service.read('board')).revision, command});
    const add = (id: string, kind = 'task', dependencies: string[] = []) => run({type: 'create-item', item: {id, title: id === 'one' || id === 'two' ? 'Same title' : id, responsibility: 'Work', acceptance: 'Verified'},
        planning: {kind, priority: 2, dependencies, references: [], area: 'Knowledge', milestone: 'Release'}});
    return {fs, store, service, options, run, add};
}
it('searches titles and IDs without returning item bodies, distinguishes duplicates and bounds results', async () => {
    const f = await fixture(); await f.add('one'); await f.add('two');
    const page = await f.service.suggest('board', {kind: 'item', search: 'Same', limit: 1});
    expect(page.items).toHaveLength(1); expect(page.hasMore).toBe(true); expect(page.items[0].id).toBe('one');
    expect((await f.service.suggest('board', {kind: 'item', excludeIds: ['one']})).items.map(row => row.id)).toEqual(['two']);
    expect(page.items[0]).not.toHaveProperty('responsibility');
    expect((await f.service.suggest('board', {kind: 'item', search: 'two'})).items[0].id).toBe('two');
    await expect(f.service.suggest('board', {kind: 'item', limit: 51})).rejects.toThrow('INVALID_LIMIT');
});
it('filters parent ranks and excludes self and dependents from dependency completion', async () => {
    const f = await fixture(); await f.add('goal', 'initiative'); await f.add('feature', 'feature'); await f.add('one'); await f.add('two', 'task', ['one']);
    expect((await f.service.suggest('board', {kind: 'parent', childKind: 'task', excludeItemId: 'one'})).items.map(row => row.id)).toEqual(['feature', 'goal']);
    expect((await f.service.suggest('board', {kind: 'parent', childKind: 'initiative'})).items).toEqual([]);
    const choices = await f.service.suggest('board', {kind: 'dependency', excludeItemId: 'one'});
    expect(choices.items.some(row => row.id === 'one' || row.id === 'two')).toBe(false);
    await expect(f.run({type: 'plan-item', itemId: 'one', planning: {kind: 'task', priority: 2, dependencies: ['two'], references: []}})).rejects.toThrow('DEPENDENCY_CYCLE');
});
it('retains archived item labels and only offers confirmed current decisions', async () => {
    const f = await fixture(); await f.add('old'); await f.run({type: 'cancel-item', itemId: 'old', reason: 'Finished'});
    await f.run({type: 'archive-items', itemIds: ['old'], reason: 'History'});
    expect((await f.service.suggest('board', {kind: 'item', search: 'old'})).items[0].archived).toBe(true);
    expect((await f.service.suggest('board', {kind: 'parent', search: 'old'})).items).toEqual([]);
    await f.run({type: 'append-record', record: {id: 'decision', kind: 'decision', title: 'Use a scoped source', content: 'PRIVATE_BODY', rationale: 'PRIVATE_REASON', itemIds: [], sources: []}});
    expect((await f.service.suggest('board', {kind: 'decision'})).items).toEqual([]);
    await f.run({type: 'review-record', recordId: 'decision', accept: true});
    const choices = await f.service.suggest('board', {kind: 'decision'}); expect(choices.items[0].label).toBe('Use a scoped source'); expect(JSON.stringify(choices)).not.toContain('PRIVATE_');
});
it('reads user-scoped session metadata only after board authorization and merges known links', async () => {
    const f = await fixture(); await f.run({type: 'register-session', sessionId: 'linked', role: 'observer', subscribed: true});
    const source = vi.fn(async () => [{id: 'known', label: 'Project planning', detail: '/project', summary: 'PRIVATE_SUMMARY'}]);
    const service = createNestOSKanban({...f.options, suggestions: async (board, kind, search, limit) => kind === 'session' ? source(board, search, limit) : undefined});
    expect((await service.suggest('board', {kind: 'session'})).items.map(row => row.id).sort()).toEqual(['known', 'linked']);
    const forbidden = createNestOSKanban({...f.options, suggestions: async (board, kind, search, limit) => kind === 'session' ? source(board, search, limit) : undefined, authorize: async () => {throw Object.assign(new Error('FORBIDDEN'), {code: 'FORBIDDEN'});}});
    await expect(forbidden.suggest('board', {kind: 'session'})).rejects.toThrow('FORBIDDEN'); expect(source).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await service.suggest('board', {kind: 'session'}))).not.toContain('PRIVATE_SUMMARY');
});
it('uses SeqFile keys for bounded event reads and preserves state through a new repository instance', async () => {
    const f = await fixture(); await f.add('one'); await f.add('two');
    const sequence = f.fs.meta.seq!, bulk = vi.fn(sequence.getEntries.bind(sequence)), walk = vi.fn(sequence.walkEntries.bind(sequence));
    const seq = new Proxy(sequence, {get: (target, name) => name === 'getEntries' ? bulk : name === 'walkEntries' ? walk : Reflect.get(target, name, target)});
    const meta = new Proxy(f.fs.meta, {get: (target, name) => name === 'seq' ? seq : Reflect.get(target, name, target)});
    const fs = new Proxy(f.fs, {get: (target, name) => name === 'meta' ? meta : Reflect.get(target, name, target)});
    const reader = createNestOSKanban({...f.options, store: await SeqKanbanStore.open(fs)});
    const events = await reader.events('board', 0, 1); expect(events).toHaveLength(1); expect(bulk.mock.calls.at(-1)![1]).toHaveLength(1); expect(walk).not.toHaveBeenCalled();
    const reopened = createNestOSKanban({...f.options, store: await SeqKanbanStore.open(f.fs)});
    expect((await reopened.suggest('board', {kind: 'area'})).items).toEqual([{id: 'Knowledge', label: 'Knowledge'}]);
    expect((await reopened.suggest('board', {kind: 'milestone'})).items).toEqual([{id: 'Release', label: 'Release'}]);
});

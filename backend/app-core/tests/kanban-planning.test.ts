import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanActor, KanbanCommand, KanbanPlanning, KanbanPolicy} from '@itookit/kanban/contracts';
import {createNestOSKanban, openProjectKanbanStore} from '../src/kanban';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {for (const dispose of disposers.splice(0)) await dispose();});
const actor = (id: string): KanbanActor => ({agentId: id, sessionId: `session-${id}`, taskId: `task-${id}`});
const estimate = {complexity: 1, workUnits: 1, durationMs: 1000, confidence: 'high' as const};
const planning = (fields: Partial<KanbanPlanning> = {}): KanbanPlanning => ({kind: 'task', priority: 2, dependencies: [], references: [], ...fields});
async function fixture(policy: Partial<KanbanPolicy> = {}) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); disposers.push(() => manager.dispose());
    const store = await openProjectKanbanStore(await manager.openFileSystem('/'));
    let now = 1000, serial = 0; const log = vi.fn();
    const serviceFor = (id = 'a') => createNestOSKanban({store, actor: actor(id), authorize: async () => {}, log, now: () => now, id: () => `id-${++serial}`});
    const service = serviceFor();
    await service.create({id: 'board', title: 'Planning', scope: {kind: 'project', projectId: 'p'},
        agents: ['a', 'b', 'c'].map(agentId => ({agentId, responsibility: 'Deliver'})), policy: {
            claimTimeoutMs: 20, leaseMs: 1000, progressTimeoutMs: 1000, transferTimeoutMs: 100,
            maxComplexity: 10, maxWorkUnits: 20, maxDurationMs: 10000, escalationSessionIds: ['supervisor'], ...policy}});
    const run = async (command: KanbanCommand, who = 'a') => serviceFor(who).execute('board', {
        operationId: `op-${++serial}`, expectedRevision: (await service.read('board')).revision, command});
    const create = (id: string, fields: Partial<KanbanPlanning> = {}, stage?: 'open' | 'backlog') => run({type: 'create-item', stage,
        item: {id, title: id, responsibility: 'Deliver scope', acceptance: 'Evidence verified', eligibleAgentIds: ['a', 'b', 'c']}, planning: planning(fields)});
    const finish = async (id: string) => {
        await run({type: 'set-stage', itemId: id, stage: 'open'});
        const board = await run({type: 'claim', itemId: id, estimate}), token = board.items.find(i => i.id === id)!.owner!.token;
        await run({type: 'register-session', itemId: id, sessionId: 'session-b', agentId: 'b', role: 'reviewer', subscribed: true});
        await run({type: 'submit', itemId: id, token, resultRef: 'evidence://verified'});
        await run({type: 'review', itemId: id, accept: true}, 'b');
    };
    return {service, serviceFor, store, log, run, create, finish, tick: (ms: number) => {now += ms;}};
}
it('keeps future work in backlog without missing-assignee alerts; promotion starts its clock', async () => {
    const f = await fixture(); await f.create('future'); f.tick(10000); await f.service.scan();
    expect((await f.service.read('board')).items[0].status).toBe('backlog');
    expect((await f.service.events('board')).filter(e => e.kind === 'escalated')).toEqual([]);
    await f.run({type: 'set-stage', itemId: 'future', stage: 'open'});
    expect((await f.service.query('board')).total).toBe(1);
    f.tick(21); await f.service.scan();
    expect((await f.service.events('board')).filter(e => e.kind === 'escalated').map(e => e.data.reason)).toEqual(['unclaimed']);
});
it('organizes initiatives, features and tasks by area/milestone with explicit evidence links', async () => {
    const f = await fixture(); await f.create('goal', {kind: 'initiative', area: 'execution', milestone: 'next'});
    await f.create('feature', {kind: 'feature', parentId: 'goal', area: 'execution', milestone: 'next'});
    await f.create('task', {parentId: 'feature', area: 'execution', milestone: 'next', priority: 0, references: ['doc/kernel-api.md']});
    const page = await f.service.query('board', {view: 'backlog', parentId: 'feature', milestone: 'next'});
    expect(page.items.map(i => i.id)).toEqual(['task']); expect(page.items[0].planning.references).toEqual(['doc/kernel-api.md']);
    await expect(f.run({type: 'set-stage', itemId: 'feature', stage: 'open'})).rejects.toThrow('PLAN_NOT_EXECUTABLE');
    await expect(f.create('wrong', {kind: 'initiative', parentId: 'task'})).rejects.toThrow('INVALID_PARENT_KIND');
    await expect(f.run({type: 'close-plan', itemId: 'feature', resultRef: 'evidence://goal'})).rejects.toThrow('CHILDREN_UNFINISHED');
});
it('gates ready admission on dependencies and rejects dependency cycles', async () => {
    const f = await fixture(); await f.create('a'); await f.create('b', {dependencies: ['a']});
    await expect(f.run({type: 'set-stage', itemId: 'b', stage: 'open'})).rejects.toThrow('DEPENDENCIES_UNFINISHED');
    await expect(f.run({type: 'plan-item', itemId: 'a', planning: planning({dependencies: ['b']})})).rejects.toThrow('DEPENDENCY_CYCLE');
    await f.finish('a'); await f.run({type: 'archive-items', itemIds: ['a'], reason: 'Delivered'});
    await f.run({type: 'set-stage', itemId: 'b', stage: 'open'});
    expect((await f.run({type: 'claim', itemId: 'b', estimate})).items.find(i => i.id === 'b')?.status).toBe('claimed');
});
it('enforces board and per-agent WIP and counts pending review as unfinished work', async () => {
    const f = await fixture({maxInProgress: 2, maxInProgressPerAgent: 1});
    for (const id of ['one', 'two', 'three']) await f.create(id, {}, 'open');
    const first = await f.run({type: 'claim', itemId: 'one', estimate});
    await expect(f.run({type: 'claim', itemId: 'two', estimate})).rejects.toThrow('AGENT_WIP_LIMIT');
    await f.run({type: 'claim', itemId: 'two', estimate}, 'b');
    await expect(f.run({type: 'claim', itemId: 'three', estimate}, 'c')).rejects.toThrow('WIP_LIMIT');
    await f.run({type: 'submit', itemId: 'one', token: first.items[0].owner!.token, resultRef: 'evidence://result'});
    await expect(f.run({type: 'claim', itemId: 'three', estimate}, 'c')).rejects.toThrow('WIP_LIMIT');
});
it('bounds the ready queue without limiting the long-term backlog', async () => {
    const f = await fixture({maxReady: 2}); await f.create('one', {}, 'open'); await f.create('two', {}, 'open');
    await expect(f.create('three', {}, 'open')).rejects.toThrow('READY_LIMIT');
    await f.create('three'); await f.create('four');
    expect((await f.service.query('board', {view: 'backlog'})).total).toBe(2);
    await f.run({type: 'claim', itemId: 'one', estimate}); await f.run({type: 'set-stage', itemId: 'three', stage: 'open'});
    expect((await f.service.overview('board')).ready).toBe(2);
});
it('archives terminal work into separate records and retains session history and evidence', async () => {
    const f = await fixture(); await f.create('done'); await f.finish('done');
    await f.run({type: 'archive-items', itemIds: ['done'], reason: 'Release complete'});
    expect((await f.service.read('board')).items).toEqual([]);
    const detail = await f.service.item('board', 'done');
    expect(detail.archive?.reason).toBe('Release complete'); expect(detail.item.resultRef).toBe('evidence://verified');
    expect(await f.service.related('session-b')).toHaveLength(1);
    expect((await f.service.query('board', {view: 'archive', sessionId: 'session-b'})).items[0].status).toBe('completed');
    await expect(f.create('done')).rejects.toThrow('ITEM_EXISTS');
    await f.run({type: 'restore-item', itemId: 'done'});
    expect((await f.service.item('board', 'done')).archive).toBeUndefined();
    expect((await f.service.read('board')).items[0].status).toBe('completed');
    await expect(f.run({type: 'claim', itemId: 'done', estimate})).rejects.toThrow('ITEM_COMPLETED');
});
it('rejects an entire archive batch containing active work without partially moving history', async () => {
    const f = await fixture(); await f.create('closed'); await f.finish('closed'); await f.create('active', {}, 'open');
    await f.run({type: 'claim', itemId: 'active', estimate});
    await expect(f.run({type: 'archive-items', itemIds: ['closed', 'active'], reason: 'Cleanup'})).rejects.toThrow('ARCHIVE_REQUIRES_CLOSED_ITEM');
    expect((await f.service.read('board')).items).toHaveLength(2); expect((await f.service.query('board', {view: 'archive'})).total).toBe(0);
});
it('automatically archives by retention and allows restored history a fresh visibility period', async () => {
    const f = await fixture({archiveAfterMs: 100}); await f.create('old'); await f.finish('old'); f.tick(101); await f.service.scan();
    expect((await f.service.query('board', {view: 'archive'})).total).toBe(1);
    await f.run({type: 'restore-item', itemId: 'old'}); expect((await f.service.read('board')).items).toHaveLength(1);
    f.tick(101); await f.service.scan(); expect((await f.service.read('board')).items).toEqual([]);
});
it('paginates summaries by priority and rejects stale or differently scoped cursors', async () => {
    const f = await fixture(); await f.create('low', {priority: 4}); await f.create('high', {priority: 0}); await f.create('normal');
    const first = await f.service.query('board', {view: 'backlog', limit: 1}); expect(first.items[0].id).toBe('high');
    expect(first.items[0]).not.toHaveProperty('acceptance');
    const next = await f.service.query('board', {view: 'backlog', limit: 1, cursor: first.nextCursor}); expect(next.items[0].id).toBe('normal');
    await expect(f.service.query('board', {view: 'archive', cursor: first.nextCursor})).rejects.toThrow('CURSOR_SCOPE_MISMATCH');
    await f.create('later'); await expect(f.service.query('board', {view: 'backlog', cursor: first.nextCursor})).rejects.toThrow('CURSOR_STALE');
    await expect(f.service.query('board', {limit: 201})).rejects.toThrow('INVALID_PAGE_SIZE');
});
it('counts archived descendants in roadmap progress without automatically accepting the feature', async () => {
    const f = await fixture(); await f.create('feature', {kind: 'feature'}); await f.create('task', {parentId: 'feature'});
    await f.finish('task'); await f.run({type: 'archive-items', itemIds: ['task'], reason: 'Finished'});
    const roadmap = await f.service.query('board', {view: 'backlog', kind: 'feature'});
    expect(roadmap.items[0].progress).toMatchObject({total: 1, completed: 1}); expect(roadmap.items[0].status).toBe('backlog');
    await f.run({type: 'close-plan', itemId: 'feature', resultRef: 'evidence://acceptance'});
    expect((await f.service.item('board', 'feature')).item.status).toBe('completed');
});
it('reminds on stale backlog without turning it into an assignment deadline', async () => {
    const f = await fixture({backlogReviewMs: 100}); await f.create('idea'); f.tick(101); await f.service.scan(); await f.service.scan();
    expect((await f.service.overview('board')).dueForReview).toBe(1);
    expect((await f.service.events('board')).filter(e => e.kind === 'escalated').map(e => e.data.reason)).toEqual(['backlog-review']);
});
it('keeps archive replay idempotent across independent module instances', async () => {
    const f = await fixture(); await f.create('old'); await f.finish('old');
    const request = {operationId: 'archive-stable', expectedRevision: (await f.service.read('board')).revision,
        command: {type: 'archive-items' as const, itemIds: ['old'], reason: 'Delivered'}};
    await f.service.execute('board', request); await f.serviceFor().execute('board', request);
    expect((await f.service.query('board', {view: 'archive'})).total).toBe(1);
});
it('preserves archived records and restores them atomically through the remote single-file adapter', async () => {
    const {ConditionalKanbanStore} = await import('@itookit/kanban/storage');
    const f = await fixture(); await f.create('old'); await f.finish('old');
    const saved = (await f.store.read('board'))!, data = new Map<string, unknown>(); let revision = 0;
    const transaction = vi.fn(async (_path: string, expected: string | null, changes: Array<{action: string; key: string; value?: unknown}>) => {
        expect(expected).toBe(revision ? String(revision) : null);
        for (const change of changes) if (change.action === 'delete') data.delete(change.key); else data.set(change.key, change.value);
        return {revision: String(++revision)};
    });
    const store = new ConditionalKanbanStore({query: async (_path: string, selection: {keys: string[]}) => ({next: null, revision: revision ? String(revision) : null,
        entries: [...data].filter(([key]) => selection.keys.includes(key)).map(([key, value]) => ({key, value}))}), transaction} as never, async () => {});
    await store.update('board', 'seed', 'seed', () => saved);
    const service = createNestOSKanban({store, actor: actor('a'), authorize: async () => {}, log: () => {}, now: () => 1000});
    await service.execute('board', {operationId: 'archive', expectedRevision: saved.board.revision,
        command: {type: 'archive-items', itemIds: ['old'], reason: 'Delivered'}});
    expect(data.has('archive/board/old')).toBe(true); expect((await service.item('board', 'old')).archive?.reason).toBe('Delivered');
    await service.execute('board', {operationId: 'restore', expectedRevision: (await service.read('board')).revision,
        command: {type: 'restore-item', itemId: 'old'}});
    expect(data.has('archive/board/old')).toBe(false); expect((await service.read('board')).items[0].status).toBe('completed');
});

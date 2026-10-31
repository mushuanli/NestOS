import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanActor, KanbanCommand, KanbanDiscoveryChange, KanbanRecordInput} from '@itookit/app-contracts';
import {createKanbanModule, SeqKanbanStore} from '../src/kanban';
import {scanContext} from '../src/kanban/scan-context';
import {UserEventService} from '../src/events/service';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const human: KanbanActor = {kind: 'human', id: 'admin'}, flow: KanbanActor = {kind: 'service', id: 'planner'};
const sources = [{sessionId: 's', messageId: 'm', revision: 'r1', role: 'user' as const}];
const proposed = {title: 'Proposed scope', responsibility: 'Proposed work', acceptance: 'Proposed verification'};
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), events = await UserEventService.open(fs);
    cleanup.push(async () => {events.journal.close();}); let serial = 0;
    const opts = {store, authorize: async () => {}, log: vi.fn(), now: () => 1000, id: () => `id-${++serial}`, notifications: {sourceId: 'context', journal: events.journal}};
    const service = createKanbanModule({...opts, actor: human}), scanner = createKanbanModule({...opts, actor: flow});
    await service.create({id: 'b', title: 'Board', scope: {kind: 'project', projectId: 'p'},
        members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator']}, {kind: 'service', id: 'planner', responsibility: 'Discover', roles: ['worker', 'reviewer']}],
        policy: {requireEstimate: false, review: 'assignee'}});
    const run = async (command: KanbanCommand, api = service) => api.execute('b', {operationId: `op-${++serial}`, expectedRevision: (await api.read('b')).revision, command});
    const create = () => run({type: 'create-item', stage: 'open', item: {id: 'work', title: 'Human scope', responsibility: 'Human work', acceptance: 'Human verification'}});
    const discover = async (changes: KanbanDiscoveryChange[], records?: KanbanRecordInput[], api = scanner) => {
        const board = await service.read('b'), runId = `run-${++serial}`, batch = {runId, leaseToken: 'lease', changes, records, checkpoints: [{sessionId: 's', revision: 'r1'}], autoCreate: false};
        const request = {operationId: runId, expectedRevision: board.revision, command: {type: 'apply-discovery' as const, batch}};
        await store.update('b', `prepare-${serial}`, runId, state => {state!.discovery = {checkpoints: {}, pending: {runId, token: 'lease', leaseUntil: 9999, autoCreate: false,
            input: {runId, executorId: 'test', board, sessions: [], connection: {kind: 'local', connectionId: 'analysis', allowContentTransfer: false}}, request}}; return state!;});
        return api.execute('b', request);
    };
    return {store, service, scanner, events, run, create, discover};
}
const update = (): KanbanDiscoveryChange => ({action: 'update', itemId: 'work', ...proposed, sources});
const record = (id: string, kind: 'log' | 'decision' = 'decision'): KanbanRecordInput => ({id, kind, title: 'PRIVATE_TITLE', content: 'PRIVATE_CONTENT', rationale: 'PRIVATE_REASON', itemIds: ['work'], sources});
it('keeps accepted human text unchanged until review, then returns Ready work to backlog', async () => {
    const f = await fixture(); await f.create(); let board = await f.discover([update()]);
    expect(board.items[0]).toMatchObject({title: 'Human scope', status: 'open'});
    const proposal = board.items[0].amendments![0]; expect(proposal.status).toBe('pending');
    board = await f.run({type: 'review-amendment', itemId: 'work', amendmentId: proposal.id, accept: true});
    expect(board.items[0]).toMatchObject({...proposed, status: 'backlog'});
    expect(board.items[0].amendments![0].status).toBe('accepted');
    expect(JSON.stringify(await f.events.listNotifications())).not.toContain('Proposed work');
});
it('protects running work and retains rejected amendment fingerprints across scans', async () => {
    const f = await fixture(); await f.create(); const owner = (await f.run({type: 'claim', itemId: 'work'})).items[0].owner;
    const changed = await f.discover([update()]), id = changed.items[0].amendments![0].id;
    expect(changed.items[0]).toMatchObject({title: 'Human scope', status: 'claimed', owner});
    await expect(f.run({type: 'review-amendment', itemId: 'work', amendmentId: id, accept: true})).rejects.toThrow('ITEM_NOT_PLANNABLE');
    await f.run({type: 'review-amendment', itemId: 'work', amendmentId: id, accept: false, reason: 'Keep current scope'});
    const again = await f.discover([update()]); expect(again.items[0].amendments).toHaveLength(1);
    expect(again.items[0].amendments![0].status).toBe('rejected');
});
it('rejects stale text merges and automated self approval', async () => {
    const f = await fixture(); await f.create(); const a = (await f.discover([update()])).items[0].amendments![0].id;
    await expect(f.run({type: 'review-amendment', itemId: 'work', amendmentId: a, accept: true}, f.scanner)).rejects.toThrow('INDEPENDENT_REVIEW_REQUIRED');
    const b = (await f.discover([{...update(), title: 'A different accepted proposal'}])).items[0].amendments![1].id;
    await f.run({type: 'review-amendment', itemId: 'work', amendmentId: b, accept: true});
    await expect(f.run({type: 'review-amendment', itemId: 'work', amendmentId: a, accept: true})).rejects.toThrow('AMENDMENT_STALE');
});
it('directly updates only the same producer’s unconfirmed proposal', async () => {
    const f = await fixture(); await f.discover([{...update(), action: 'create'}]);
    let board = await f.discover([{...update(), title: 'Reworded draft'}]);
    expect(board.items[0].title).toBe('Reworded draft'); expect(board.items[0].amendments).toBeUndefined();
    await f.run({type: 'publish-proposal', itemId: 'work'});
    board = await f.discover([update()]); expect(board.items[0].title).toBe('Reworded draft'); expect(board.items[0].amendments).toHaveLength(1);
});
it('does not respawn rejected or archived proposals under a different extracted ID', async () => {
    const f = await fixture(); await f.discover([{...update(), action: 'create'}]);
    await f.run({type: 'cancel-item', itemId: 'work', reason: 'Not needed'});
    expect((await f.discover([{...update(), action: 'create', itemId: 'another-id'}])).items).toHaveLength(1);
    await f.run({type: 'archive-items', itemIds: ['work'], reason: 'Historical rejection'});
    expect((await f.discover([{...update(), action: 'create', itemId: 'third-id'}])).items).toHaveLength(0);
    expect((await f.store.read('b'))!.discovery!.pending).toBeUndefined();
});
it('keeps Flow logs and decisions as drafts and confirms or supersedes decisions atomically', async () => {
    const f = await fixture(); await f.create(); await f.discover([], [record('decision'), record('log', 'log')]);
    expect((await f.service.records('b', {status: 'draft'})).items).toHaveLength(2);
    await f.run({type: 'review-record', recordId: 'decision', accept: true});
    await f.run({type: 'append-record', record: {...record('replacement'), supersedes: 'decision'}});
    await f.run({type: 'review-record', recordId: 'replacement', accept: true});
    expect((await f.service.record('b', 'decision')).status).toBe('superseded');
    expect((await f.service.record('b', 'replacement')).supersedes).toBe('decision');
    expect((await f.service.item('b', 'work')).item.status).toBe('open');
    expect(JSON.stringify(await f.events.listNotifications())).not.toContain('PRIVATE_');
    expect((await f.service.related('s'))[0].id).toBe('b');
});
it('preserves linked context across card archival and binds record pagination to the board revision', async () => {
    const f = await fixture(); await f.create(); await f.run({type: 'append-record', record: record('one', 'log')});
    await f.run({type: 'append-record', record: {...record('two', 'log'), title: 'Other log'}});
    const page = await f.service.records('b', {itemId: 'work', limit: 1}); expect(page.nextCursor).toBeDefined();
    await f.run({type: 'cancel-item', itemId: 'work', reason: 'Stop'}); await f.run({type: 'archive-items', itemIds: ['work'], reason: 'Close'});
    expect((await f.service.records('b', {itemId: 'work'})).total).toBe(2);
    await expect(f.service.records('b', {itemId: 'work', limit: 1, cursor: page.nextCursor})).rejects.toThrow('CURSOR_STALE');
});
it('includes only confirmed current project records in bounded scan context', async () => {
    const f = await fixture(); await f.create(); await f.run({type: 'append-record', record: record('accepted')});
    await f.run({type: 'append-record', record: record('draft')}); await f.run({type: 'review-record', recordId: 'accepted', accept: true});
    const state = (await f.store.read('b'))!, input = scanContext(state.board, state, [], {executor: {identity: 'flow'}, policy: {maxInputBytes: 32000, connection: {kind: 'local', connectionId: 'analysis', allowContentTransfer: false}}} as never, 'run');
    expect(input.projectContext!.records.map(record => record.id)).toEqual(['accepted']); expect(input.projectContext!.omittedRecords).toBe(0); expect(input.projectContext!.excludedRecords).toBe(1);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThanOrEqual(32000);
});

it('forces a human-bound analysis Flow to produce drafts rather than confirmed logs', async () => {
    const f = await fixture(); await f.create(); await f.discover([], [record('generated-log', 'log')], f.service);
    expect(await f.service.record('b', 'generated-log')).toMatchObject({status: 'draft', origin: 'flow', author: {kind: 'human', id: 'admin'}});
});

it('does not merge equal descriptions across different planning milestones', async () => {
    const f = await fixture();
    const planning = {kind: 'task', priority: 2, dependencies: [], references: [], milestone: 'first-release'};
    await f.discover([{...update(), action: 'create', planning}]);
    const board = await f.discover([{...update(), action: 'create', itemId: 'next-release', planning: {...planning, milestone: 'next-release'}}]);
    expect(board.items).toHaveLength(2);
});

it('deduplicates the same extracted record but retains equal log text from a new source message', async () => {
    const f = await fixture(); await f.create();
    await f.discover([], [record('first-log', 'log')]);
    await f.discover([], [record('repeated-log', 'log')]);
    expect((await f.service.records('b', {kind: 'log'})).total).toBe(1);
    await f.discover([], [{...record('new-event', 'log'), sources: [{...sources[0], messageId: 'another-user-message'}]}]);
    expect((await f.service.records('b', {kind: 'log'})).total).toBe(2);
});

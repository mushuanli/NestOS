import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanActor, KanbanBoardInput, KanbanCommand, KanbanPlanning} from '@itookit/kanban/contracts';
import {createNestOSKanban, projectKanbanEvents} from '../src/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import {UserEventService} from '../src/events/service';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const dispose of cleanup.splice(0)) await dispose();});
const alice: KanbanActor = {kind: 'human', id: 'alice'}, bob: KanbanActor = {kind: 'human', id: 'bob'}, robot: KanbanActor = {kind: 'service', id: 'robot'};
async function fixture(extra: Partial<KanbanBoardInput> = {}, notifications = false) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), events = await UserEventService.open(fs);
    cleanup.push(async () => {events.journal.close();});
    let serial = 0, now = 1000; const log = vi.fn();
    const options = {store, authorize: async () => {}, log, now: () => now, id: () => `id-${++serial}`,
        ...(notifications ? {notifications: {sourceId: 'collection:operations', journal: events.journal}} : {})};
    const serviceFor = (actor = alice) => createNestOSKanban({...options, actor}), service = serviceFor();
    const input: KanbanBoardInput = {id: 'work', title: 'Operations', scope: {kind: 'collection', namespace: 'personal', id: 'operations'},
        members: [{kind: 'human', id: 'alice', responsibility: 'Handle requests', roles: ['worker']},
            {kind: 'human', id: 'bob', responsibility: 'Verify outcomes', roles: ['reviewer']},
            {kind: 'service', id: 'robot', responsibility: 'Automate bounded requests', roles: ['worker']}],
        workTypes: [{id: 'campaign', label: 'Campaign', rank: 0, executable: false}, {id: 'request', label: 'Request', rank: 1, executable: true}],
        defaultWorkType: 'request', policy: {requireEstimate: false, claimTimeoutMs: 10}, ...extra};
    await service.create(input);
    const run = async (command: KanbanCommand, actor = alice) => serviceFor(actor).execute('work', {
        operationId: `op-${++serial}`, expectedRevision: (await service.read('work')).revision, command});
    const create = async (id = 'request', planning?: KanbanPlanning) => run({type: 'create-item', stage: 'open',
        item: {id, title: 'PRIVATE_TITLE', responsibility: 'PRIVATE_DESCRIPTION', acceptance: 'Verified request'}, planning});
    return {service, serviceFor, events, store, options, input, log, create, run, tick: (ms: number) => {now += ms;}};
}
it('supports human ownership and independent review without fabricated Agent or Session identities', async () => {
    const f = await fixture(); await f.create();
    const claimed = await f.run({type: 'claim', itemId: 'request'}), item = claimed.items[0];
    expect(item.owner).toMatchObject({kind: 'human', id: 'alice'}); expect(item.owner).not.toHaveProperty('sessionId');
    await f.run({type: 'submit', itemId: 'request', token: item.owner!.token, resultRef: 'record://verified'});
    expect((await f.run({type: 'review', itemId: 'request', accept: true}, bob)).items[0].status).toBe('completed');
});
it('transfers work to a service and fences the previous human owner', async () => {
    const f = await fixture({policy: {review: 'assignee', requireEstimate: false}}); await f.create();
    const token = (await f.run({type: 'claim', itemId: 'request'})).items[0].owner!.token;
    await f.run({type: 'request-transfer', itemId: 'request', token, target: {kind: 'service', id: 'robot'}});
    const moved = await f.run({type: 'accept-transfer', itemId: 'request'}, robot);
    await expect(f.run({type: 'renew', itemId: 'request', token})).rejects.toThrow('OWNER_MISMATCH');
    expect((await f.run({type: 'submit', itemId: 'request', token: moved.items[0].owner!.token, resultRef: 'record://result'}, robot)).items[0].status).toBe('completed');
});
it('counts assignee WIP by principal rather than missing agentId fields', async () => {
    const f = await fixture(); await f.create('one'); await f.create('two'); await f.create('three');
    await f.run({type: 'claim', itemId: 'one'});
    await expect(f.run({type: 'claim', itemId: 'two'})).rejects.toThrow('ASSIGNEE_WIP_LIMIT');
    expect((await f.run({type: 'claim', itemId: 'two'}, robot)).items.find(i => i.id === 'two')?.owner?.id).toBe('robot');
});
it('uses configured business types and hierarchy instead of hardcoded software feature names', async () => {
    const f = await fixture();
    await f.run({type: 'create-item', item: {id: 'campaign', title: 'Campaign', responsibility: 'Outcome', acceptance: 'Outcome verified'},
        planning: {kind: 'campaign', priority: 1, dependencies: [], references: []}});
    await f.create('request', {kind: 'request', parentId: 'campaign', priority: 1, dependencies: [], references: ['record://source']});
    expect((await f.service.query('work', {view: 'all', kind: 'request'})).total).toBe(1);
    await expect(f.run({type: 'set-stage', itemId: 'campaign', stage: 'open'})).rejects.toThrow('PLAN_NOT_EXECUTABLE');
});
it('blocks new ownership until unblocked and preserves actual execution state', async () => {
    const f = await fixture(); await f.create();
    await f.run({type: 'block-item', itemId: 'request', reason: 'Waiting for external decision'});
    await expect(f.run({type: 'claim', itemId: 'request'})).rejects.toThrow('ITEM_BLOCKED');
    await f.run({type: 'unblock-item', itemId: 'request'});
    const board = await f.run({type: 'claim', itemId: 'request'});
    await expect(f.run({type: 'block-item', itemId: 'request', reason: 'Waiting'}, robot)).rejects.toThrow('OWNER_MISMATCH');
    await f.run({type: 'block-item', itemId: 'request', token: board.items[0].owner!.token, reason: 'Waiting'});
    expect((await f.service.read('work')).items[0].status).toBe('claimed');
});
it('requires explicit Agent execution identity and explicit valid column mappings', async () => {
    const f = await fixture();
    expect(() => f.serviceFor({agentId: 'missing-session'})).toThrow('INVALID_ID');
    await expect(f.service.create({...f.input, id: 'bad-columns', columns: [{id: 'one', label: 'All', states: ['open']}]})).rejects.toThrow('INVALID_COLUMNS');
});
it('publishes overdue work to the existing system notifications and does not duplicate it on replay', async () => {
    const f = await fixture({}, true); await f.create(); f.tick(11); await f.service.scan();
    const notifications = await f.events.listNotifications();
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0].event.value).toMatchObject({type: 'kanban.escalated.unclaimed', notification: 'error'});
    expect(JSON.stringify(notifications)).not.toContain('PRIVATE_');
    await projectKanbanEvents(f.options.notifications!, f.service, 'work', 1011);
    expect((await f.events.listNotifications()).items).toHaveLength(1);
    await f.events.setNotificationRead(notifications.items[0].event.id, true);
    expect((await f.events.listNotifications()).items[0].read).toBe(true);
});
it('does not roll back committed domain work when the system event journal fails, then catches up', async () => {
    const f = await fixture({}, true), transact = vi.spyOn(f.events.journal, 'transaction');
    transact.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_ERROR'), {code: 'EIO'}));
    expect((await f.create()).items).toHaveLength(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_ERROR');
    f.tick(11); await f.service.scan();
    expect((await f.events.listNotifications()).items).toHaveLength(1);
    expect(f.log.mock.calls.some(([row]) => row.stage === 'notify' && row.result === 'failure')).toBe(true);
});
it('replays safely after a committed notification transaction loses its response', async () => {
    const f = await fixture(); await f.create(); f.tick(11); await f.service.scan();
    const transaction = f.events.journal.transaction.bind(f.events.journal);
    let calls = 0;
    const journal = {transaction: (async (...args: Parameters<typeof transaction>) => {
        const result = await transaction(...args);
        if (++calls === 2) throw Object.assign(new Error('Lost response after commit'), {code: 'EIO'});
        return result;
    }) as typeof transaction};
    const target = {sourceId: 'lost-response', journal};
    await expect(projectKanbanEvents(target, f.service, 'work', 1011)).rejects.toThrow('Lost response');
    await projectKanbanEvents(target, f.service, 'work', 1011);
    expect((await f.events.listNotifications()).items).toHaveLength(1);
});
it('isolates notification checkpoints for equal board IDs in different stores', async () => {
    const f = await fixture(); await f.create(); f.tick(11); await f.service.scan();
    for (const sourceId of ['project:first', 'project:second', 'project:first']) {
        await projectKanbanEvents({sourceId, journal: f.events.journal}, f.service, 'work', 1011);
    }
    const notifications = (await f.events.listNotifications()).items;
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map(i => i.event.value.resourceId)).size).toBe(2);
});
it('keeps system notifications opt-in per event and excludes message bodies even when enabled', async () => {
    const f = await fixture({notifications: {rules: {escalated: 'none', message: 'info'}}}, true);
    await f.create(); f.tick(11); await f.service.scan(); expect((await f.events.listNotifications()).items).toHaveLength(0);
    await f.run({type: 'message', message: 'PRIVATE_MESSAGE', recipientSessionIds: []});
    const notifications = await f.events.listNotifications(); expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0].event.value.type).toBe('kanban.message'); expect(JSON.stringify(notifications)).not.toContain('PRIVATE_MESSAGE');
});
it('does not notify historical escalation that was already resolved before connection', async () => {
    const f = await fixture(); await f.create(); f.tick(11); await f.service.scan();
    await f.run({type: 'claim', itemId: 'request'});
    await projectKanbanEvents({sourceId: 'late-connection', journal: f.events.journal}, f.service, 'work', 1011);
    expect((await f.events.listNotifications()).items).toHaveLength(0);
    const events = await f.events.readEvents(); expect(events.events.some(e => e.value.type === 'kanban.escalated.unclaimed')).toBe(true);
});
it('links business records without creating artificial conversation identities', async () => {
    const f = await fixture(); await f.create();
    await f.run({type: 'link-reference', itemId: 'request', reference: {system: 'support', id: 'case-42', revision: 'v1'}});
    await f.run({type: 'link-reference', itemId: 'request', reference: {system: 'support', id: 'case-42', revision: 'v1'}});
    const page = await f.service.query('work', {reference: {system: 'support', id: 'case-42'}});
    expect(page.total).toBe(1); expect(page.items[0].externalRefs).toHaveLength(1);
});
it('allows humans to release their own work but requires settled execution proof for automation', async () => {
    const f = await fixture(); await f.create('human'); await f.create('automated');
    let board = await f.run({type: 'claim', itemId: 'human'});
    await f.run({type: 'release-item', itemId: 'human', token: board.items.find(i => i.id === 'human')!.owner!.token, next: 'backlog', reason: 'Reschedule'});
    board = await f.run({type: 'claim', itemId: 'automated'}, robot);
    const command = {type: 'release-item' as const, itemId: 'automated', token: board.items.find(i => i.id === 'automated')!.owner!.token, next: 'cancelled' as const, reason: 'Stopped'};
    await expect(f.run(command, robot)).rejects.toThrow('EXECUTION_NOT_SETTLED');
    const verified = createNestOSKanban({...f.options, actor: robot, verifyRelease: async () => true});
    const result = await verified.execute('work', {operationId: 'verified-release', expectedRevision: (await f.service.read('work')).revision, command});
    expect(result.items.find(i => i.id === 'automated')?.status).toBe('cancelled');
});
it('notifies expired transfers even though the pending request was automatically cleared', async () => {
    const f = await fixture({policy: {requireEstimate: false, transferTimeoutMs: 10}}, true); await f.create();
    const token = (await f.run({type: 'claim', itemId: 'request'})).items[0].owner!.token;
    await f.run({type: 'request-transfer', itemId: 'request', token, target: {kind: 'service', id: 'robot'}});
    f.tick(11); await f.service.scan();
    expect((await f.events.listNotifications()).items.some(i => i.event.value.type === 'kanban.escalated.transfer-timeout')).toBe(true);
});
it('supports domain deadlines independently of execution estimates', async () => {
    const f = await fixture({}, true);
    await f.create('due', {kind: 'request', priority: 1, dependencies: [], references: [], dueAt: 1005});
    f.tick(6); await f.service.scan();
    expect((await f.events.listNotifications()).items.some(i => i.event.value.type === 'kanban.escalated.due-date')).toBe(true);
});

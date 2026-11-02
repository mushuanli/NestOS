import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule} from '@itookit/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import type {KanbanCommand, KanbanService} from '@itookit/kanban/contracts';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {UserEventService} from '../src/events/service';
import {initializeWorkspaceMessages} from '../src/run/workspace-messages';
import {developmentObserver} from '../src/presets/kanban-development-observer';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture(verifyDelivery?: (dispatchId: string) => Promise<void>, lifecycle?: Parameters<typeof developmentObserver>[0]['lifecycle']) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs);
    await journal.open();
    const actor = {kind: 'human' as const, id: 'admin'}, principal = {kind: 'service' as const, id: 'worker'};
    const service = createKanbanModule({store, actor, authorize: async () => {}});
    const worker = createKanbanModule({store, actor: principal, authorize: async () => {}});
    await service.create({id: 'board', title: 'Board', scope: {kind: 'system'}, policy: {requireEstimate: false, review: 'independent'},
        members: [{...actor, responsibility: 'Review', roles: ['coordinator', 'reviewer']}, {...principal, responsibility: 'Work', roles: ['worker']}]});
    let seq = 0;
    const command = async (client: KanbanService, command: KanbanCommand) => client.execute('board', {
        operationId: 'request-' + ++seq, expectedRevision: (await client.read('board')).revision, command});
    await command(service, {type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true,
        items: [{id: 'item', title: 'Task', responsibility: 'Work', acceptance: 'Evidence', assignee: principal, dependsOn: [], outputs: ['result']}]}});
    await command(service, {type: 'link-reference', itemId: 'item', reference: {system: 'nestos-remote-project', id: 'project'}});
    await command(worker, {type: 'prepare-dispatch', itemId: 'item', dispatchId: 'attempt'});
    const dispatch = (await service.workflow('board')).dispatches.attempt;
    const directory = '/workspace/_nestos/worktrees/attempt/_nestos/kanban', scope = {runId: 'plan', itemId: 'item', attemptId: 'attempt'};
    await journal.update('worktree:attempt', () => ({directory: '/workspace/_nestos/worktrees/attempt', branch: 'work/attempt', baseCommit: 'a'.repeat(40)}));
    await initializeWorkspaceMessages(fs, directory, scope);
    const events = await UserEventService.open(fs);
    const observer = developmentObserver({fs, events, verifyDelivery, lifecycle, kernel: {inspectSession: async () => ({getShared: async () => undefined})},
        projects: {get: async () => ({path: '/project'}) as never, openWorkspace: async () => ({fs, dispose: async () => {}}) as never}, wake() {}});
    closes.push(() => observer.dispose());
    const publish = (id: string, type: string) => fs.driver.createFile({parentPath: directory + '/inbox', name: id + '.json',
        content: JSON.stringify({schema: 'work-message/1', ...scope, id, type, content: 'Business message'})});
    return {publish, service, events, journal, observe: (outcome: 'running' | 'succeeded') => observer.observe({boardId: 'board', dispatch,
        service, worker, observation: {outcome, ...(outcome === 'succeeded' ? {outputs: []} : {})}})};
}
it('requires a result and native completion before returning a reviewable observation', async () => {
    const f = await fixture();
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'unknown', code: 'WORKSPACE_RESULT_MISSING'});
    await f.publish('result', 'result');
    expect(await f.observe('running')).toMatchObject({outcome: 'running'});
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'succeeded'});
    expect((await f.service.item('board', 'item')).item.status).toBe('claimed');
});
it('blocks clarification, emits one global notification, and does not let a result bypass it', async () => {
    const f = await fixture(); await f.publish('question', 'clarification');
    await f.observe('running'); await f.observe('running');
    expect((await f.service.item('board', 'item')).item.blocked?.reason).toBe('WORKSPACE_INPUT_REQUIRED');
    expect((await f.events.listNotifications()).items.filter(row => row.event.value.type === 'kanban.workspace.clarification')).toHaveLength(1);
    await f.publish('result', 'result');
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'running', code: 'WORKSPACE_INPUT_REQUIRED'});
});

it('blocks policy violations and allows review only after successful verification', async () => {
    let allowed = false;
    const f = await fixture(async () => {if (!allowed) throw Object.assign(new Error('Unauthorized commit'), {code: 'UNAUTHORIZED_COMMIT'});});
    await f.publish('result', 'result');
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'unknown', code: 'UNAUTHORIZED_COMMIT'});
    expect((await f.service.item('board', 'item')).item.blocked).toBeDefined();
    allowed = true;
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'succeeded'});
    expect((await f.service.item('board', 'item')).item.blocked).toBeUndefined();
});

it('waits for declared terminal finalization before reporting successful delivery', async () => {
    let settled = false;
    const f = await fixture(undefined, {enqueue: async () => {}, scan: async () => {}, dispose: async () => {}, settled: async () => settled});
    await f.publish('result', 'result');
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'running', code: 'LIFECYCLE_PENDING'});
    settled = true;
    expect(await f.observe('succeeded')).toMatchObject({outcome: 'succeeded'});
});

it('settles a reported error only after native completion and notifies once',async()=>{
    const f=await fixture();await f.publish('failure','error');
    expect(await f.observe('running')).toMatchObject({outcome:'running'});
    expect(await f.observe('succeeded')).toMatchObject({outcome:'failed',code:'WORKSPACE_ERROR_REPORTED'});
    expect(await f.observe('succeeded')).toMatchObject({outcome:'failed'});
    expect((await f.events.listNotifications()).items.filter(row=>row.event.value.type==='kanban.workspace.error')).toHaveLength(1);
});

it('publishes artifacts from immutable result files rather than session summaries',async()=>{
    const f=await fixture();await f.publish('file-result','result');
    const result=await f.observe('succeeded');
    expect(result.outputs).toHaveLength(1);
    const payload=await f.journal.get<string>('artifact:'+result.outputs![0].sha256);
    expect(JSON.parse(payload!)).toEqual([expect.objectContaining({id:'file-result',type:'result',content:'Business message'})]);
});

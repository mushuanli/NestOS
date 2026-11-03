import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule} from '@itookit/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import type {KanbanCommand, KanbanRecordQuery} from '@itookit/kanban/contracts';
import {KanbanWorkLog} from '../src/kanban/work-log';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture(review: 'independent' | 'assignee' = 'independent') {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs); let time = 1000, sequence = 0;
    const diagnostic = vi.fn(), logs = new KanbanWorkLog(fs, undefined, diagnostic); await logs.open();
    const service = createKanbanModule({store, actor: {kind: 'human', id: 'admin'}, now: () => time++, authorize: async () => {}, log: vi.fn()});
    await service.create({id: 'board', title: 'Development', policy: {review}, scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['coordinator','worker','reviewer']}, {kind: 'human', id: 'reviewer', responsibility: 'Review', roles: ['coordinator','reviewer']}]});
    const command = async (command: KanbanCommand) => service.execute('board', {operationId: 'request-' + ++sequence, expectedRevision: (await service.read('board')).revision, command});
    const create = async (id: string, parentId?: string, kind = 'task') => command({type: 'create-item', item: {id, title: id, responsibility: 'Work', acceptance: 'Verified'},
        planning: {kind, priority: 2, dependencies: [], references: [], ...(parentId ? {parentId} : {})}});
    const records = (query?: KanbanRecordQuery) => logs.records(service, 'board', query);
    const reviewer = createKanbanModule({store, actor: {kind: 'human', id: 'reviewer'}, now: () => time++, authorize: async () => {}, log: vi.fn()});
    return {fs, service, reviewer, command, create, logs, records, diagnostic};
}
it('persists created, cancelled and blocked logs and aggregates child work under its parent', async () => {
    const f = await fixture(); await f.create('feature', undefined, 'feature'); await f.create('child', 'feature');
    await f.command({type: 'block-item', itemId: 'child', reason: 'WAITING_INPUT'});
    await f.command({type: 'cancel-item', itemId: 'child', reason: 'User choice'});
    const page = await f.records({kind: 'log', itemId: 'feature'});
    expect(page.items.map(row => row.activity?.stage)).toEqual(['task.cancelled', 'task.blocked', 'task.created', 'task.created']);
    expect(page.items[0].itemIds).toEqual(['child','feature']);
    await f.logs.synchronize('board', f.service); expect((await f.records({kind: 'log'})).total).toBe(4);
    const reopened = new KanbanWorkLog(f.fs); await reopened.open();
    expect(await reopened.record(f.service, 'board', page.items[0].id)).toMatchObject({activity: {stage: 'task.cancelled'}, status: 'confirmed'});
});
it('logs real execution transitions and bindings while omitting unchanged renewals', async () => {
    const f = await fixture(); await f.create('task');
    const principal = {kind: 'human' as const, id: 'admin'};
    await f.command({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true,
        items: [{id: 'task', title: 'task', responsibility: 'Work', acceptance: 'Verified', expectedRevision: 1, assignee: principal, dependsOn: [], outputs: []}]}});
    await f.command({type: 'prepare-dispatch', itemId: 'task', dispatchId: 'dispatch', estimate: {complexity: 1, workUnits: 1, durationMs: 60000, confidence: 'high'}});
    await f.command({type: 'link-reference', itemId: 'task', reference: {system: 'nestos-execution-session', id: 'session', revision: 'dispatch'}});
    await f.logs.append(f.service, 'board', 'task', {stage: 'worktree.prepared', result: 'success', dispatchId: 'dispatch', fields: {branch: 'work/dispatch'}, references: [{system: 'nestos-worktree', id: 'dispatch'}]});
    await f.command({type: 'link-reference', itemId: 'task', reference: {system: 'nestos-worktree', id: 'dispatch'}});
    const dispatch = (await f.service.workflow('board')).dispatches.dispatch;
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome: 'running'});
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome: 'running'});
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome: 'unknown', code: 'OFFLINE'});
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome: 'running'});
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome: 'failed', code: 'EXECUTOR_FAILED'});
    const page = await f.records({kind: 'log', limit: 200});
    expect(page.items.filter(row => row.activity?.stage === 'worktree.prepared')).toHaveLength(1);
    expect(page.items.filter(row => row.activity?.stage === 'execution.running')).toHaveLength(2);
    expect(page.items.find(row => row.activity?.stage === 'execution.failed')).toMatchObject({activity: {result: 'failure', code: 'EXECUTOR_FAILED'}});
    const session = page.items.find(row => row.activity?.stage === 'session.bound')!;
    expect(session.externalRefs).toContainEqual({system: 'nestos-execution-session', id: 'session', revision: 'dispatch'});
});
it('merges manual and automatic logs without skipping or duplicating entries across pages', async () => {
    const f = await fixture(); await f.create('one');
    await f.command({type: 'append-record', record: {id: 'manual', kind: 'log', title: 'Manual note', content: 'PRIVATE_CONTENT', itemIds: ['one'], sources: []}});
    await f.create('two'); await f.create('three');
    const first = await f.records({kind: 'log', limit: 2});
    const second = await f.records({kind: 'log', limit: 2, cursor: first.nextCursor});
    expect([...first.items,...second.items].map(row => row.title)).toEqual(['three · 任务已创建','two · 任务已创建','Manual note','one · 任务已创建']);
    expect(second.nextCursor).toBeUndefined(); expect(first.total).toBe(4);
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('PRIVATE_CONTENT');
    await f.create('four'); await expect(f.records({kind: 'log', limit: 2, cursor: first.nextCursor})).rejects.toMatchObject({code: 'CURSOR_STALE'});
});
it('does not consume the coordination record budget and keeps authorization on derived records', async () => {
    const f = await fixture(); await f.create('task');
    for (let index = 0; index < 205; index++) await f.logs.append(f.service, 'board', 'task', {stage: 'execution.running', result: 'success', dispatchId: 'attempt-' + index});
    expect((await f.records({kind: 'log', limit: 200})).total).toBe(206);
    expect((await f.service.records('board', {limit: 200})).total).toBe(0);
    const row = (await f.records({kind: 'log'})).items[0];
    const denied = {...f.service, records: vi.fn(async () => {throw Object.assign(new Error('PRIVATE'), {code: 'EACCES'});})};
    await expect(f.logs.record(denied, 'board', row.id)).rejects.toMatchObject({code: 'EACCES'});
    await expect(f.logs.records(f.service, 'other', {kind: 'log'})).rejects.toMatchObject({code: 'BOARD_NOT_FOUND'});
});
it('retries projection after a transactional persistence failure without repeating the task or its log', async () => {
    const f = await fixture(); await f.create('once');
    const seq = f.fs.meta.seq!, transaction = seq.transaction!.bind(seq);
    const broken = new KanbanWorkLog({driver: f.fs.driver, meta: {seq: {
        getEntry: seq.getEntry.bind(seq), transaction: async run => transaction(async tx => run(new Proxy(tx, {get(target, key) {
            if (key === 'setEntry') return async (path: string, key: string, value: string) => {await target.setEntry(path, key, value); if (key.startsWith('checkpoint/')) throw Object.assign(new Error('PRIVATE_STORAGE_BODY'), {code: 'EIO'});};
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        }}))),
    }}} as typeof f.fs, undefined, f.diagnostic);
    await expect(broken.synchronize('board', f.service)).rejects.toMatchObject({code: 'EIO'});
    expect((await f.records({kind: 'log'})).total).toBe(1); expect((await f.service.read('board')).items).toHaveLength(1);
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('PRIVATE_STORAGE_BODY');
});
it.each(['succeeded', 'cancelled'] as const)('records the %s execution outcome independently from acceptance', async outcome => {
    const f = await fixture(); await f.create('task');
    await f.command({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true, items: [{id: 'task', title: 'task', responsibility: 'Work', acceptance: 'Verified', expectedRevision: 1,
        assignee: {kind: 'human', id: 'admin'}, dependsOn: [], outputs: []}]}});
    await f.command({type: 'prepare-dispatch', itemId: 'task', dispatchId: 'dispatch', estimate: {complexity: 1, workUnits: 1, durationMs: 60000, confidence: 'high'}});
    const dispatch = (await f.service.workflow('board')).dispatches.dispatch;
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome, outputs: []});
    const logs = await f.records({kind: 'log'});
    expect(logs.items.find(row => row.activity?.stage === 'execution.' + outcome)).toBeDefined();
    expect(logs.items.find(row => row.activity?.stage === 'task.completed')).toBeUndefined();
    if (outcome === 'succeeded') {
        await f.reviewer.execute('board', {operationId: 'accept', expectedRevision: (await f.service.read('board')).revision, command: {type: 'accept-execution', dispatchId: 'dispatch', accept: true}});
        const completed = (await f.records({kind: 'log'})).items.filter(row => row.activity?.stage === 'task.completed');
        expect(completed).toHaveLength(1); expect(completed[0].author).toEqual({kind: 'human', id: 'reviewer'});
    }
});

it('reports automatic acceptance as completed instead of waiting for a second review', async () => {
    const f = await fixture('assignee'); await f.create('task');
    await f.command({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true, items: [{id: 'task', title: 'task', responsibility: 'Work', acceptance: 'Verified', expectedRevision: 1,
        assignee: {kind: 'human', id: 'admin'}, dependsOn: [], outputs: []}]}});
    await f.command({type: 'prepare-dispatch', itemId: 'task', dispatchId: 'dispatch', estimate: {complexity: 1, workUnits: 1, durationMs: 60000, confidence: 'high'}});
    const dispatch = (await f.service.workflow('board')).dispatches.dispatch;
    await f.command({type: 'observe-execution', dispatchId: 'dispatch', fence: dispatch.fence, outcome: 'succeeded', outputs: []});
    const logs = await f.records({kind: 'log'});
    expect(logs.items.filter(row => row.activity?.stage === 'task.completed')).toHaveLength(1);
    expect(logs.items.find(row => row.activity?.stage === 'execution.succeeded')).toBeUndefined();
});
it('backfills old bindings as an observed snapshot instead of inventing a historical creation time', async () => {
    const f = await fixture(); await f.create('old');
    await f.command({type: 'link-reference', itemId: 'old', reference: {system: 'nestos-execution-session', id: 'historical', revision: 'old-dispatch'}});
    const legacy = {...f.service, events: async (...args: Parameters<typeof f.service.events>) => (await f.service.events(...args)).map(row => ({...row, data: {...row.data, reference: undefined}}))};
    const before = Date.now(), page = await f.logs.records(legacy, 'board', {kind: 'log'});
    const snapshot = page.items.find(row => row.activity?.stage === 'association.observed')!;
    expect(snapshot.createdAt).toBeGreaterThanOrEqual(before); expect(snapshot.externalRefs?.[0].id).toBe('historical');
    expect((await f.logs.records(legacy, 'board', {kind: 'log'})).total).toBe(page.total);
});

it('repairs a legacy completion projection once without changing board state or dispatching work',async()=>{
    const f=await fixture();await f.create('task');
    await f.command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,items:[{id:'task',title:'task',responsibility:'Work',acceptance:'Verified',expectedRevision:1,
        assignee:{kind:'human',id:'admin'},dependsOn:[],outputs:[]}]}});
    await f.command({type:'prepare-dispatch',itemId:'task',dispatchId:'dispatch',estimate:{complexity:1,workUnits:1,durationMs:60000,confidence:'high'}});
    const dispatch=(await f.service.workflow('board')).dispatches.dispatch;
    await f.command({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded',outputs:[]});
    await f.reviewer.execute('board',{operationId:'accept',expectedRevision:(await f.service.read('board')).revision,command:{type:'accept-execution',dispatchId:dispatch.id,accept:true}});
    const legacy={...f.service,events:async(...args:Parameters<typeof f.service.events>)=>(await f.service.events(...args)).map(event=>({...event,data:{...event.data,reason:undefined,status:undefined}}))};
    const path='/var/lib/kanban/work-log.seq',key='snapshot/board/';
    await f.fs.meta.seq!.setEntry(path,key,'2');
    const before=await f.logs.records(legacy,'board',{kind:'log'});expect(before.items.some(row=>row.activity?.stage==='task.completed')).toBe(false);
    await f.fs.meta.seq!.setEntry(path,key,'1');
    const board=await f.service.read('board'),workflow=await f.service.workflow('board'),execute=vi.spyOn(f.service,'execute');
    const reopened=new KanbanWorkLog(f.fs);await reopened.open();
    const after=await reopened.records(legacy,'board',{kind:'log'}),completed=after.items.filter(row=>row.activity?.stage==='task.completed');
    expect(after.total).toBe(before.total+1);expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({createdAt:board.items[0].closedAt,activity:{dispatchId:'dispatch',fields:{evidence:'accepted-dispatch'}}});
    expect((await reopened.records(legacy,'board',{kind:'log'})).total).toBe(after.total);expect(execute).not.toHaveBeenCalled();
    expect(await f.service.read('board')).toEqual(board);expect(await f.service.workflow('board')).toEqual(workflow);
});

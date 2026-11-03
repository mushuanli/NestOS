import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule} from '@itookit/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import type {KanbanCommand, KanbanWorkType} from '@itookit/kanban/contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {createRecordExecution, validateRemoteReferences} from '../src/kanban/record-execution';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture(enabled = true, workTypes?: KanbanWorkType[]) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs);
    await journal.open();
    const actor = {kind: 'human' as const, id: 'admin'}, log = vi.fn();
    const service = createKanbanModule({store, actor, authorize: async () => {}, log});
    const folders = ['one', 'two', 'local'].map(id => ({name: id, path: '/' + id, project: {id, source: {kind: id === 'local' ? 'local' : 'remote'}}}));
    const projects = {list: async () => folders, get: async (id: string) => {
        const row = folders.find(row => row.project.id === id); if (!row) throw Object.assign(new Error('Missing'), {code: 'ENOENT'}); return row;
    }} as unknown as Pick<ProjectService, 'list' | 'get'>;
    await service.create({id: 'source', title: 'Development', ...(workTypes ? {workTypes, defaultWorkType: workTypes.find(type => type.executable)!.id} : {}), scope: {kind: 'system'}, members: [{...actor, responsibility: 'Manage', roles: ['coordinator', 'reviewer', 'worker']}, {kind: 'human', id: 'reviewer', responsibility: 'Review', roles: ['reviewer']}], policy: {requireEstimate: false, review: 'assignee'}});
    const reviewer = createKanbanModule({store, actor: {kind: 'human', id: 'reviewer'}, authorize: async () => {}, log});
    let sequence = 0;
    const command = async (command: KanbanCommand) => (command.type === 'review' ? reviewer : service).execute('source', {operationId: 'request-' + ++sequence, expectedRevision: (await service.read('source')).revision, command});
    await command({type: 'configure-automation', settings: {enabled, autoAccept: false,
        planner: {system: 'agent', id: 'planner', revision: '1'}, executor: {system: 'agent', id: 'worker', revision: '1'},
        coordinator: {kind: 'service', id: 'planner'}, worker: {kind: 'service', id: 'worker'}}});
    await command({type: 'append-record', record: {id: 'decision', kind: 'decision', title: 'Goal', content: 'PRIVATE_REQUIREMENT', rationale: 'Acceptance criteria', itemIds: [], sources: [],
        externalRefs: ['one', 'two'].map(id => ({system: 'nestos-remote-project', id}))}});
    const open = () => createRecordExecution({service, journal, projects, log});
    return {service, command, open, projects, log, journal};
}

it('rejects unconfirmed/stale decisions and local project selection', async () => {
    const f = await fixture(), execution = f.open();
    await expect(execution.runRecord('source', {operationId: 'run', recordId: 'decision', expectedRevision: 1})).rejects.toMatchObject({code: 'DECISION_NOT_CONFIRMED'});
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    await expect(execution.runRecord('source', {operationId: 'run', recordId: 'decision', expectedRevision: 1})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    await expect(validateRemoteReferences(f.projects, {externalRefs: [{system: 'nestos-remote-project', id: 'local'}]})).rejects.toMatchObject({code: 'REMOTE_PROJECT_REQUIRED'});
    expect(await execution.recordResources()).toHaveLength(2);
});

it('deduplicates concurrent runs and preserves remote bindings across reopening', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2}, execution = f.open();
    const [first, second] = await Promise.all([execution.runRecord('source', request), execution.runRecord('source', {...request, operationId: 'double-click'})]);
    expect(first.id).toBe(second.id);
    const board = await f.service.read(first.boardId);
    expect(first.boardId).toBe('source'); expect(board.items).toHaveLength(3); expect(board.automation).toMatchObject({enabled: true, autoAccept: false});
    expect(board.items.filter(item => first.itemIds!.includes(item.id)).map(item => item.externalRefs![0].id)).toEqual(['one', 'two']);
    expect(board.items.filter(item => item.planning?.parentId === first.rootItemId)).toHaveLength(2);
    await f.open().scan(); expect(await f.open().runRecord('source', request)).toMatchObject({id: first.id, boardId: first.boardId});
    expect((await f.service.catalog()).filter(board => board.scope.kind === 'collection')).toHaveLength(0);
    expect((await f.service.record('source', 'decision')).status).toBe('confirmed');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REQUIREMENT');
    await expect(execution.runRecord('source', {...request, expectedRevision: 9})).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
});

it('recovers a committed creation when the response is lost without creating duplicate items', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const original = f.service.execute.bind(f.service); let lost = false;
    vi.spyOn(f.service, 'execute').mockImplementation(async (id, request) => {
        const result = await original(id, request);
        if (request.command.type === 'create-item' && !lost) {lost = true; throw Object.assign(new Error('PRIVATE_REPLY'), {code: 'EIO'});}
        return result;
    });
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'EIO'});
    const run = await f.open().runRecord('source', request);
    expect((await f.service.read(run.boardId)).items).toHaveLength(3);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REPLY');
});

it('keeps one run after linking the decision advances its revision and does not duplicate a feature', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const first = await f.open().runRecord('source', {operationId: 'first', recordId: 'decision', expectedRevision: 2});
    const decision = await f.service.record('source', 'decision'); expect(decision.itemIds).toContain(first.rootItemId);
    const request = {operationId: 'again', recordId: 'decision', expectedRevision: decision.revision};
    expect((await f.open().runRecord('source', request)).id).toBe(first.id);
    expect((await f.open().runRecord('source', request)).id).toBe(first.id);
    expect((await f.service.read('source')).items).toHaveLength(3);
    await expect(f.open().runRecord('source', {...request, operationId: 'separate', placement: 'new-board'})).rejects.toMatchObject({code: 'DECISION_EXECUTION_PLACEMENT_CONFLICT'});
});
it('requires explicitly resuming paused AI and only creates a board when selected', async () => {
    const f = await fixture(false); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'AUTOMATION_PAUSED'});
    expect((await f.service.read('source')).items).toHaveLength(0);
    const run = await f.open().runRecord('source', {...request, placement: 'new-board'});
    expect(run.boardId).not.toBe('source'); expect((await f.service.catalog())).toHaveLength(2);
    expect((await f.service.read('source')).automation?.enabled).toBe(false);
    expect((await f.service.read(run.boardId)).automation?.enabled).toBe(true);
});
it('creates a single task for one project and derives completion only from its own work', async () => {
    const f = await fixture();
    await f.command({type: 'append-record', record: {id: 'small', kind: 'decision', title: 'Cloze modes', content: 'Implement', rationale: 'Verified', itemIds: [], sources: [], externalRefs: [{system: 'nestos-remote-project', id: 'one'}]}});
    await f.command({type: 'review-record', recordId: 'small', accept: true});
    await f.command({type: 'create-item', item: {id: 'unrelated', title: 'Other', responsibility: 'Other', acceptance: 'Other'}});
    await f.command({type: 'block-item', itemId: 'unrelated', reason: 'Independent work'});
    const run = await f.open().runRecord('source', {operationId: 'small', recordId: 'small', expectedRevision: 2});
    expect(run.itemIds).toHaveLength(1); expect(run.rootItemId).toBe(run.itemIds![0]); expect(run.state).toBe('running');
    await f.command({type: 'set-stage', itemId: run.rootItemId!, stage: 'open'});
    const claimed = await f.command({type: 'claim', itemId: run.rootItemId!});
    await f.command({type: 'submit', itemId: run.rootItemId!, token: claimed.items.find(item => item.id === run.rootItemId)!.owner!.token, resultRef: 'verified'});
    await f.command({type: 'review', itemId: run.rootItemId!, accept: true});
    await f.open().scan();
    expect((await f.open().recordExecutions('source', 'small'))[0].state).toBe('completed');
    const completed=await f.service.record('source','small');
    await expect(f.open().runRecord('source',{operationId:'after-completed',recordId:'small',expectedRevision:completed.revision})).rejects.toMatchObject({code:'DECISION_EXECUTION_COMPLETED'});
    expect((await f.service.read('source')).items.find(item => item.id === 'unrelated')?.blocked).toBeDefined();
});
it('closes the feature after its own children complete and keeps the approved decision', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'feature', recordId: 'decision', expectedRevision: 2});
    await expect(f.command({type: 'close-plan', itemId: run.rootItemId!, resultRef: 'early'})).rejects.toMatchObject({code: 'CHILDREN_UNFINISHED'});
    for (const itemId of run.itemIds!) {
        await f.command({type: 'set-stage', itemId, stage: 'open'});
        const claimed = await f.command({type: 'claim', itemId});
        await f.command({type: 'submit', itemId, token: claimed.items.find(item => item.id === itemId)!.owner!.token, resultRef: 'verified'});
        await f.command({type: 'review', itemId, accept: true});
    }
    await f.open().scan();
    expect((await f.service.item('source', run.rootItemId!)).item.status).toBe('completed');
    expect((await f.service.record('source', 'decision')).status).toBe('confirmed');
});

it('resumes legacy dedicated boards in place without introducing parent items or moving identities', async () => {
    const f = await fixture(false); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const record = await f.service.record('source', 'decision'), source = await f.service.read('source');
    const legacy = {id: 'legacy', sourceBoardId: 'source', recordId: 'decision', recordRevision: 2, boardId: 'run-legacy', state: 'preparing',
        createdAt: 1, updatedAt: 1, record, automation: source.automation};
    await f.journal.update('record-runs:source', () => [legacy]);
    await f.journal.update('record-operation:legacy-click', () => legacy);
    await f.open().scan();
    const run = await f.open().runRecord('source', {operationId: 'legacy-click', recordId: 'decision', expectedRevision: 2});
    expect(run.boardId).toBe('run-legacy'); expect(run.rootItemId).toBeUndefined();
    expect((await f.service.read(run.boardId)).items.map(item => item.id)).toEqual(['work-0', 'work-1']);
    expect((await f.service.read('source')).items).toHaveLength(0);
    await f.open().scan(); expect((await f.service.read(run.boardId)).items).toHaveLength(2);
});
it('marks only the affected decision run failed when a task is cancelled', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'cancelled', recordId: 'decision', expectedRevision: 2});
    await f.command({type: 'cancel-item', itemId: run.itemIds![0], reason: 'User choice'}); await f.open().scan();
    expect((await f.open().recordExecutions('source', 'decision'))[0]).toMatchObject({state: 'failed', code: 'DECISION_TASK_CANCELLED'});
    expect((await f.service.item('source', run.rootItemId!)).item.status).toBe('backlog');
});

it('uses configured work type ranks instead of requiring feature/task identifiers', async () => {
    const f = await fixture(true, [{id: 'bundle', label: 'Delivery', rank: 5, executable: false}, {id: 'action', label: 'Work', rank: 9, executable: true}]);
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'custom', recordId: 'decision', expectedRevision: 2, placement: 'new-board'});
    const board = await f.service.read(run.boardId);
    expect(board.items.find(item => item.id === run.rootItemId)?.planning?.kind).toBe('bundle');
    expect(board.items.filter(item => run.itemIds!.includes(item.id)).every(item => item.planning?.kind === 'action' && item.planning.parentId === run.rootItemId)).toBe(true);
    await f.open().scan(); expect((await f.service.read(run.boardId)).items).toHaveLength(3);
});

it('provides a single resource selector that inherits and locks the parent project',async()=>{
    const f=await fixture(),reference={system:'nestos-remote-project',id:'one'};
    await f.command({type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Work',acceptance:'Verified',externalRefs:[reference]}});
    expect(await f.open().itemResources('source','parent')).toMatchObject({selected:reference,required:true,readonly:true,resources:[
        {reference:{system:'nestos-remote-project',id:'one'}},{reference:{system:'nestos-remote-project',id:'two'}}]});
});

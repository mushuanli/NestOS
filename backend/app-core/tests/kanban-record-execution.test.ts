import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule} from '@itookit/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import type {KanbanCommand} from '@itookit/kanban/contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {createRecordExecution, validateRemoteReferences} from '../src/kanban/record-execution';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs);
    await journal.open();
    const actor = {kind: 'human' as const, id: 'admin'}, log = vi.fn();
    const service = createKanbanModule({store, actor, authorize: async () => {}, log});
    const folders = ['one', 'two', 'local'].map(id => ({name: id, path: '/' + id, project: {id, source: {kind: id === 'local' ? 'local' : 'remote'}}}));
    const projects = {list: async () => folders, get: async (id: string) => {
        const row = folders.find(row => row.project.id === id); if (!row) throw Object.assign(new Error('Missing'), {code: 'ENOENT'}); return row;
    }} as unknown as Pick<ProjectService, 'list' | 'get'>;
    await service.create({id: 'source', title: 'Development', scope: {kind: 'system'}, members: [{...actor, responsibility: 'Manage', roles: ['coordinator', 'reviewer', 'worker']}]});
    let sequence = 0;
    const command = async (command: KanbanCommand) => service.execute('source', {operationId: 'request-' + ++sequence, expectedRevision: (await service.read('source')).revision, command});
    await command({type: 'configure-automation', settings: {enabled: false, autoAccept: false,
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
    expect(board.items).toHaveLength(2); expect(board.automation).toMatchObject({enabled: true, autoAccept: false});
    expect(board.items.map(item => item.externalRefs![0].id)).toEqual(['one', 'two']);
    await f.open().scan(); expect(await f.open().runRecord('source', request)).toMatchObject({id: first.id, boardId: first.boardId});
    expect((await f.service.catalog()).filter(board => board.scope.kind === 'collection')).toHaveLength(1);
    expect((await f.service.record('source', 'decision')).status).toBe('confirmed');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REQUIREMENT');
    await expect(execution.runRecord('source', {...request, expectedRevision: 9})).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
});

it('recovers a committed creation when the response is lost without creating duplicate items', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const original = f.service.execute.bind(f.service); let lost = false;
    vi.spyOn(f.service, 'execute').mockImplementation(async (id, request) => {
        const result = await original(id, request);
        if (id !== 'source' && !lost) {lost = true; throw Object.assign(new Error('PRIVATE_REPLY'), {code: 'EIO'});}
        return result;
    });
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'EIO'});
    const run = await f.open().runRecord('source', request);
    expect((await f.service.read(run.boardId)).items).toHaveLength(2);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REPLY');
});

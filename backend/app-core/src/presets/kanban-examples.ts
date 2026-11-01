import {KanbanError} from '@itookit/kanban';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {installKanbanContent, inspectKanbanContent, type KanbanStore} from '@itookit/kanban/storage';
import type {KanbanContent, KanbanClient, KanbanWorkType, KanbanNotificationPolicy} from '@itookit/kanban/contracts';
import type {InitialFileEntry, InitialResourceProvider} from './initial-files';
import demo from './kanban-demo.json';
const log = createModuleLogger('kanban-examples');
const resourceId = 'kanban:nestos-demo';
const actor = {kind: 'human' as const, id: 'admin'};
const content: KanbanContent = {
    id: demo.id, version: demo.version,
    board: {id: demo.id, title: demo.title, scope: {kind: 'system'},
        members: [{...actor, responsibility: demo.responsibility, roles: ['worker', 'reviewer', 'coordinator']}],
        workTypes: demo.workTypes as KanbanWorkType[], defaultWorkType: 'task', policy: {requireEstimate: false, review: 'assignee'},
        notifications: demo.notifications as KanbanNotificationPolicy},
    items: demo.items.map(entry => ({introduced: 'introduced' in entry ? Number(entry.introduced) : 1,
        command: {type: 'create-item', item: {id: entry.id, title: entry.title, responsibility: entry.responsibility, acceptance: entry.acceptance},
            planning: {...entry.planning, priority: entry.planning.priority as 0 | 1 | 2 | 3 | 4}, stage: 'stage' in entry ? entry.stage as 'backlog' | 'open' : undefined},
        blocked: 'blocked' in entry ? String(entry.blocked) : undefined,
        completion: 'example' in entry ? {resultRef: demo.resultRef, archiveReason: entry.example === 'archived' ? demo.archiveReason : undefined} : undefined})),
    records: demo.records.map(({introduced, ...record}) => ({introduced, confirmed: 'confirmExample' in record && record.confirmExample,
        record: {...record, kind: record.kind as 'log' | 'decision'}})),
    amendments: demo.amendments.map(entry => ({...entry, proposedBy: {...entry.proposedBy, kind: 'service'}})),
};

/** The application supplies product content; installation belongs to the library. */
export class KanbanExamples implements InitialResourceProvider {
    constructor(private readonly store: KanbanStore, private readonly service?: KanbanClient) {}
    async list(): Promise<InitialFileEntry[]> {
        const status = await inspectKanbanContent(this.store, content);
        return [{id: resourceId, group: 'kanban', name: demo.title, path: `#/kanban/${encodeURIComponent('/board/' + demo.id)}`, exists: status.complete}];
    }

    async seed(): Promise<void> {await this.install('seed', false);}
    async restore(id: string): Promise<boolean> {
        if (id !== resourceId) throw new Error('INITIAL_FILE_UNKNOWN');
        const changed = await this.install('restore', true);
        if (changed && this.service) await this.publish();
        return changed;
    }
    private async install(stage: 'seed' | 'restore', fillMissing: boolean): Promise<boolean> {
        const operationId = stage === 'seed' ? `preset:kanban-demo:v${demo.version}` : randomUUID(), started = Date.now(); let changed = false, created = 0;
        try {
            const result = await installKanbanContent({store: this.store, actor, content, operationId, fillMissing, missingReferences: 'detach',
                authorize: async ({board}) => {if (board.id !== demo.id || board.scope.kind !== 'system') throw new KanbanError('INVALID_PRESET_SCOPE');},
                log: event => {if (event.result === 'failure') log.warn('kanban.content', event);},
            });
            changed = result.changed; created = result.created;
            log.info('kanban.examples', {operationId, stage, result: changed ? 'restored' : 'preserved', created, durationMs: Date.now() - started});
            return changed;
        } catch (error) {
            const raw = (error as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z_0-9]{1,80}$/.test(raw) ? raw : 'KANBAN_EXAMPLES_FAILED';
            log.warn('kanban.examples', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); throw error;
        }
    }
    private async publish(): Promise<void> {
        try {
            const board = await this.service!.read(demo.id);
            await this.service!.execute(demo.id, {operationId: randomUUID(), expectedRevision: board.revision, command: {type: 'scan'}});
        } catch {
            // The committed source events remain available for the normal health monitor.
            log.warn('kanban.examples', {operationId: randomUUID(), stage: 'notify', result: 'failure', code: 'KANBAN_NOTIFICATION_DEFERRED'});
        }
    }
}

import {reportKanbanHealth} from './health-events';
import type {IFileSystem} from '@itookit/vfs-core';
import type {UserEventService} from '../events/service';
import type {DiagnosticJournal} from '../diagnostics/journal';
import {createNestOSKanban} from './module';
import {openPersonalKanbanStore} from './store';
import {KanbanExamples} from '../presets/kanban-examples';
import {KanbanError} from '@itookit/kanban';
import {createLocalKanbanSessionSource} from './session-source';

/** The authenticated runtime owns this user store; project boards require their own binding. */
export async function createPersonalKanban(fs: IFileSystem, events: UserEventService, diagnostics: DiagnosticJournal, sessions?: Pick<import('@itookit/llm-session/contracts').ISessionRepository, 'listSummaries'|'getManifest'>, kernel?: Pick<import('@itookit/durable-kernel').Kernel,'sessionActivity'>) {
    const store = await openPersonalKanbanStore(fs);
    await new KanbanExamples(store).seed();
    const service = createNestOSKanban({
        executionSessions:sessions&&kernel?{source:createLocalKanbanSessionSource(sessions,kernel)}:undefined,
        suggestions: async (_board, kind, search, limit) => {
            if (kind !== 'session') return undefined;
            const rows = await sessions?.listSummaries?.() ?? [];
            return rows.filter(row => `${row.title} ${row.id} ${row.folder ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit)
                .map(row => ({id: row.id, label: row.title.slice(0, 256), detail: row.folder?.slice(0, 256) ?? ''}));
        },
        store, actor: {kind: 'human', id: 'admin'},
        authorize: async ({board, command}) => {
            if (board.scope.kind === 'project') throw new KanbanError('PROJECT_STORE_REQUIRED');
            if (command?.type === 'apply-discovery') throw new KanbanError('DISCOVERY_BINDING_REQUIRED');
        },
        notifications: {sourceId: 'personal:user-store', journal: events.journal},
        log: event => {diagnostics.record({...event, module: 'application', operation: 'kanban.operation',
            level: event.result === 'failure' ? 'warn' : 'info'});},
    });
    try {await service.scan();await reportKanbanHealth(events);}
    catch(error) {await reportKanbanHealth(events,error);}
    return service;
}

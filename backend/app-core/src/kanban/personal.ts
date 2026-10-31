import type {IFileSystem} from '@itookit/vfs-core';
import type {UserEventService} from '../events/service';
import type {DiagnosticJournal} from '../diagnostics/journal';
import {createKanbanModule} from './module';
import {SeqKanbanStore} from './store';
import {KanbanExamples} from '../presets/kanban-examples';
import {KanbanError} from './ports';

/** The authenticated runtime owns this user store; project boards require their own binding. */
export async function createPersonalKanban(fs: IFileSystem, events: UserEventService, diagnostics: DiagnosticJournal, sessions?: Pick<import('@itookit/llm-session/contracts').ISessionRepository, 'listSummaries'>) {
    const store = await SeqKanbanStore.open(fs);
    await new KanbanExamples(store).seed();
    return createKanbanModule({
        sessionSuggestions: async (_board, search, limit) => {
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
}

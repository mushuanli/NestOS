import {validateWorkProjects} from './task-projects';
import {KanbanWorkLog} from './work-log';
import {KanbanAutomationJournal} from './automation-journal';
import {createRecordExecution, validateRemoteReferences} from './record-execution';
import {createPersonalKanbanAutomation, type PersonalKanbanAutomationOptions} from './personal-automation';
import {authorizeAutomation} from './automation-authority';
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
export async function createPersonalKanban(fs: IFileSystem, events: UserEventService, diagnostics: DiagnosticJournal, sessions?: Pick<import('@itookit/llm-session/contracts').ISessionRepository, 'listSummaries'|'getManifest'>, kernel?: Pick<import('@itookit/durable-kernel').Kernel,'sessionActivity'>, automationOptions?: PersonalKanbanAutomationOptions) {
    const store = await openPersonalKanbanStore(fs);
    await new KanbanExamples(store).seed();
    const journal = new KanbanAutomationJournal(fs); await journal.open();
    const base = personalOptions({store, journal, events, diagnostics, sessions, kernel, automationOptions});
    const workLog = new KanbanWorkLog(fs, events, base.log); await workLog.open();
    const withLogs = {...base, onCommitted: (boardId: string, source: import('@itookit/kanban/contracts').KanbanService) => workLog.synchronize(boardId, source)};
    const service = createNestOSKanban({...withLogs, actor: {kind: 'human', id: 'admin'}});
    const records = automationOptions?.projects ? createRecordExecution({service, journal, projects: automationOptions.projects, requiresItemResource:automationOptions.requiresItemResource, log: base.log}) : undefined;
    const automation = automationOptions ? createPersonalKanbanAutomation({...automationOptions, fs, service, journal, workLog, log: base.log,
        serviceFor: actor => createNestOSKanban({...withLogs, actor})}) : undefined;
    try {await service.scan();await reportKanbanHealth(events);}
    catch(error) {await reportKanbanHealth(events,error);}
    return {...service,
        records: (boardId: string, query?: import('@itookit/kanban/contracts').KanbanRecordQuery) => workLog.records(service, boardId, query),
        record: (boardId: string, recordId: string) => workLog.record(service, boardId, recordId),
        ...(records ? {itemResources: records.itemResources, recordResources: records.recordResources, runRecord: records.runRecord, recordExecutions: async (boardId: string, recordId: string) => (await workLog.record(service, boardId, recordId)).kind === 'decision' ? records.recordExecutions(boardId, recordId) : []} : {}),
        ...(automation ? {automationCatalog: automation.automationCatalog, analysisStatus: automation.analysisStatus} : {}),
        scan: async () => {
            await service.scan();
            const results = await Promise.allSettled([records?.scan(), automation?.scan()]);
            const failures = results.filter(result => result.status === 'rejected');
            if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'KANBAN_SCAN_FAILED');
        },
        quiesce: async () => {await records?.quiesce(); await automation?.quiesce(); await service.quiesce();},
        dispose: async () => {await records?.quiesce(); await automation?.quiesce(); await service.dispose();}};
}


type PersonalOptions = {
    store: Awaited<ReturnType<typeof openPersonalKanbanStore>>; journal: KanbanAutomationJournal;
    events: UserEventService; diagnostics: DiagnosticJournal;
    sessions?: Pick<import('@itookit/llm-session/contracts').ISessionRepository, 'listSummaries' | 'getManifest'>;
    kernel?: Pick<import('@itookit/durable-kernel').Kernel, 'sessionActivity'>; automationOptions?: PersonalKanbanAutomationOptions;
};
function personalOptions({store, journal, events, diagnostics, sessions, kernel, automationOptions}: PersonalOptions) {
    return {
        executionSessions:sessions&&kernel?{source:createLocalKanbanSessionSource(sessions,kernel,automationOptions?.executionResource)}:undefined,
        suggestions: async (_board, kind, search, limit) => {
            if (kind !== 'session') return undefined;
            const rows = await sessions?.listSummaries?.() ?? [];
            return rows.filter(row => `${row.title} ${row.id} ${row.folder ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit)
                .map(row => ({id: row.id, label: row.title.slice(0, 256), detail: row.folder?.slice(0, 256) ?? ''}));
        },
        store, verifyOutputs: async ({board, itemId, dispatchId, outputs}: Parameters<NonNullable<import('./module').NestOSKanbanOptions['verifyOutputs']>>[0]) => {
            const state = await store.read(board.id);
            const dispatch = dispatchId ? state?.workflow?.dispatches[dispatchId] : undefined;
            if (dispatch?.itemId !== itemId || !await journal.verify(outputs, dispatch.id)) return false;
            await automationOptions?.verifyWork?.(dispatch.id);
            return true;
        },
        authorize: async (input: Parameters<import('./module').NestOSKanbanOptions['authorize']>[0]) => {
            const {board, command} = input;
            await authorizeAutomation(input, automationOptions?.catalog);
            if(command&&automationOptions?.projects)await validateWorkProjects(automationOptions.projects,board,command,automationOptions.requiresItemResource?.(board)===true);
            if (command?.type === 'configure-automation' && command.settings.preparation)
                automationOptions?.validatePreparation?.(command.settings.preparation, command.settings.preparationOptions);
            if (command?.type === 'append-record' && command.record.id.startsWith('activity-')) throw new KanbanError('RESERVED_RECORD_ID');
            if (command?.type === 'append-record' && command.record.externalRefs?.length) {
                if (!automationOptions?.projects) throw new KanbanError('PROJECT_SELECTION_UNAVAILABLE');
                await validateRemoteReferences(automationOptions.projects, command.record);
            }
            if (board.scope.kind === 'project') throw new KanbanError('PROJECT_STORE_REQUIRED');
            if (command?.type === 'apply-discovery') throw new KanbanError('DISCOVERY_BINDING_REQUIRED');
        },
        notifications: {sourceId: 'personal:user-store', journal: events.journal},
        log: event => {diagnostics.record({...event, module: 'application', operation: 'kanban.operation',
            level: event.result === 'failure' ? 'warn' : 'info'});},
    } satisfies Omit<import('./module').NestOSKanbanOptions, 'actor'>;
}

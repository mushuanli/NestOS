import {journalCommand} from './journal-command';
import {sha256HexSync} from '@itookit/common';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {KanbanBoard, KanbanClient, KanbanCommand, KanbanProjectRecord, KanbanRecordExecution, KanbanRecordRunRequest} from '@itookit/kanban/contracts';
import {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from './validation';
import {safeCode} from './automation-analysis';

export const REMOTE_PROJECT_REFERENCE = 'nestos-remote-project';
interface SavedRun extends KanbanRecordExecution {sourceBoardId: string; record: KanbanProjectRecord; automation: NonNullable<KanbanBoard['automation']>}
interface Options {
    service: KanbanClient; journal: KanbanAutomationJournal; projects: Pick<ProjectService, 'list' | 'get'>;
    log(input: {operationId: string; boardId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}

/** A restartable projection from an approved record into an independently reviewable board. */
export function createRecordExecution(options: Options) {
    const pending = new Map<string, Promise<KanbanRecordExecution>>();
    const resume = (run: SavedRun) => {
        let job = pending.get(run.id);
        if (!job) {job = advance(options, run).finally(() => {pending.delete(run.id);}); pending.set(run.id, job);}
        return job;
    };
    return {
        recordResources: async () => (await options.projects.list()).filter(row => row.project?.source?.kind === 'remote')
            .map(row => ({reference: {system: REMOTE_PROJECT_REFERENCE, id: row.project!.id}, label: row.displayName ?? row.name})),
        runRecord: async (boardId: string, request: KanbanRecordRunRequest) => resume(await prepare(options, boardId, request)),
        recordExecutions: async (boardId: string, recordId: string) => {
            await options.service.record(boardId, recordId);
            const runs = await options.journal.get<SavedRun[]>('record-runs:' + boardId) ?? [];
            return runs.filter(run => run.recordId === recordId).map(view);
        },
        async scan() {
            const errors: unknown[] = [];
            for (const board of await options.service.catalog()) {
                for (const run of await options.journal.get<SavedRun[]>('record-runs:' + board.id) ?? []) {
                    if (run.state !== 'completed') {try {await resume(run);} catch (error) {errors.push(error);}}
                }
            }
            if (errors.length) throw new AggregateError(errors, 'RECORD_EXECUTION_SCAN_FAILED');
        },
        async quiesce() {await Promise.allSettled([...pending.values()]);},
    };
}

export async function validateRemoteReferences(projects: Pick<ProjectService, 'get'>, record: Pick<KanbanProjectRecord, 'externalRefs'>): Promise<void> {
    const refs = record.externalRefs?.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE) ?? [];
    requireValue(refs.length <= 16 && new Set(refs.map(ref => ref.id)).size === refs.length, 'INVALID_PROJECT_SELECTION');
    for (const ref of refs) requireValue((await projects.get(ref.id)).project?.source?.kind === 'remote', 'REMOTE_PROJECT_REQUIRED');
}

async function prepare(options: Options, boardId: string, request: KanbanRecordRunRequest): Promise<SavedRun> {
    requireValue(typeof request.operationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId), 'INVALID_OPERATION_ID');
    const record = await options.service.record(boardId, request.recordId);
    const frozen = await options.journal.get<SavedRun>('record-operation:' + request.operationId);
    if (frozen) {
        requireValue(frozen.sourceBoardId === boardId && frozen.recordId === request.recordId && frozen.recordRevision === request.expectedRevision, 'IDEMPOTENCY_CONFLICT');
        return frozen;
    }
    requireValue(record.kind === 'decision' && record.status === 'confirmed', 'DECISION_NOT_CONFIRMED');
    requireValue(record.revision === request.expectedRevision, 'REVISION_CONFLICT');
    const board = await options.service.read(boardId);
    requireValue(board.automation, 'AUTOMATION_BINDING_REQUIRED');
    await validateRemoteReferences(options.projects, record);
    requireValue(record.externalRefs?.some(ref => ref.system === REMOTE_PROJECT_REFERENCE), 'REMOTE_PROJECT_REQUIRED');
    const id = sha256HexSync(JSON.stringify([boardId, record.id, record.revision]));
    const run: SavedRun = {id, sourceBoardId: boardId, recordId: record.id, recordRevision: record.revision, boardId: 'run-' + id,
        state: 'preparing', createdAt: Date.now(), updatedAt: Date.now(), record, automation: structuredClone(board.automation)};
    const saved = await options.journal.update<SavedRun[]>('record-runs:' + boardId, previous => {
        if (previous?.some(row => row.id === id)) return previous;
        requireValue(!previous?.some(row => row.recordId === record.id && !['completed', 'failed'].includes(row.state)), 'DECISION_EXECUTION_UNSETTLED');
        requireValue((previous?.length ?? 0) < 100, 'RECORD_EXECUTION_LIMIT');
        return [...previous ?? [], run];
    });
    const original = saved.find(row => row.id === id)!;
    return options.journal.update<SavedRun>('record-operation:' + request.operationId, previous => {
        requireValue(!previous || previous.id === original.id, 'IDEMPOTENCY_CONFLICT'); return previous ?? original;
    });
}

async function advance(options: Options, run: SavedRun): Promise<KanbanRecordExecution> {
    const started = Date.now();
    try {
        await validateRemoteReferences(options.projects, run.record);
        await materialize(options, run);
        const board = await options.service.read(run.boardId);
        const state = board.items.every(item => item.status === 'completed') ? 'completed'
            : board.items.some(item => item.blocked) ? 'blocked' : board.items.every(item => ['completed', 'review'].includes(item.status)) ? 'review' : 'running';
        const updated = await save(options, {...run, state, code: undefined, updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: 'success', durationMs: Date.now() - started});
        return view(updated);
    } catch (error) {
        const code = safeCode(error, 'RECORD_EXECUTION_FAILED');
        await save(options, {...run, state: 'blocked', code, updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: 'failure', code, durationMs: Date.now() - started});
        throw error;
    }
}

async function materialize(options: Options, run: SavedRun): Promise<void> {
    const actor = await options.service.currentPrincipal();
    await options.service.create({id: run.boardId, title: run.record.title, scope: {kind: 'collection', namespace: 'decision-run', id: run.id},
        members: [{...actor, responsibility: 'Review decision execution', roles: ['coordinator', 'reviewer', 'worker']}], policy: {requireEstimate: false, review: 'independent'}});
    const refs = run.record.externalRefs!.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE);
    for (const [index, reference] of refs.entries()) {
        await once(options, run, 'item-' + index, {type: 'create-item', item: {id: 'work-' + index, title: run.record.title,
            responsibility: run.record.content, acceptance: run.record.rationale ?? run.record.content, externalRefs: [reference, {system: 'nestos-decision-run', id: run.id}]}});
    }
    await once(options, run, 'automation', {type: 'configure-automation', settings: {...run.automation, enabled: true, autoAccept: false}});
}

async function once(options: Options, run: SavedRun, stage: string, command: KanbanCommand): Promise<void> {
    const key = 'record-stage:' + run.id + ':' + stage;
    await journalCommand(options.journal, options.service, run.boardId, key, command);
}
async function save(options: Options, run: SavedRun): Promise<SavedRun> {
    await options.journal.update<SavedRun[]>('record-runs:' + run.sourceBoardId, previous => (previous ?? []).map(row => row.id === run.id ? run : row));
    return run;
}
function view(run: SavedRun): KanbanRecordExecution {
    const {id, recordId, recordRevision, boardId, state, createdAt, updatedAt, code} = run;
    return {id, recordId, recordRevision, boardId, state, createdAt, updatedAt, ...(code ? {code} : {})};
}

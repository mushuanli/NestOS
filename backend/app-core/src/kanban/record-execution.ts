import {DEFAULT_KANBAN_WORK_TYPES} from '@itookit/kanban/contracts';
import {journalCommand} from './journal-command';
import {sha256HexSync} from '@itookit/common';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {KanbanBoard, KanbanClient, KanbanCommand, KanbanProjectRecord, KanbanRecordExecution, KanbanRecordRunRequest, KanbanItem} from '@itookit/kanban/contracts';
import {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from './validation';
import {safeCode} from './automation-analysis';

export const REMOTE_PROJECT_REFERENCE = 'nestos-remote-project';
interface SavedRun extends KanbanRecordExecution {
    placement?: KanbanRecordRunRequest['placement']; requestRevision?: number; taskKind?: string; parentKind?: string;
    sourceBoardId: string; record: KanbanProjectRecord; automation: NonNullable<KanbanBoard['automation']>}
interface Options {
    requiresItemResource?(board:KanbanBoard):boolean;
    service: KanbanClient; journal: KanbanAutomationJournal; projects: Pick<ProjectService, 'list' | 'get'>;
    log(input: {operationId: string; boardId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}

/** A restartable projection from an approved decision into work on its chosen board. */
export function createRecordExecution(options: Options) {
    const pending = new Map<string, Promise<KanbanRecordExecution>>();
    const resume = (run: SavedRun) => {
        let job = pending.get(run.id);
        if (!job) {job = advance(options, run).finally(() => {pending.delete(run.id);}); pending.set(run.id, job);}
        return job;
    };
    return {
        itemResources:async(boardId:string,parentId?:string)=>{
            const board=await options.service.read(boardId),parent=parentId?(await options.service.item(boardId,parentId)).item:undefined;
            const refs=parent?.externalRefs?.filter(ref=>ref.system===REMOTE_PROJECT_REFERENCE)??[];
            const resources=(await options.projects.list()).filter(row=>row.project?.source?.kind==='remote')
                .map(row=>({reference:{system:REMOTE_PROJECT_REFERENCE,id:row.project!.id},label:row.displayName??row.name}));
            return {resources,selected:refs.length===1?refs[0]:undefined,readonly:refs.length===1,required:refs.length===1||options.requiresItemResource?.(board)===true};
        },
        recordResources: async () => (await options.projects.list()).filter(row => row.project?.source?.kind === 'remote')
            .map(row => ({reference: {system: REMOTE_PROJECT_REFERENCE, id: row.project!.id}, label: row.displayName ?? row.name})),
        runRecord: async (boardId: string, request: KanbanRecordRunRequest) => {
            const started = Date.now(), operationId = sha256HexSync(JSON.stringify([boardId, request.operationId]));
            let run: SavedRun;
            try {
                run = await prepare(options, boardId, request);
                options.log({operationId, boardId, stage: 'record.prepare', result: 'success', durationMs: Date.now() - started});
            } catch (error) {
                options.log({operationId, boardId, stage: 'record.prepare', result: 'failure', code: safeCode(error, 'RECORD_PREPARATION_FAILED'), durationMs: Date.now() - started});
                throw error;
            }
            return resume(run);
        },
        recordExecutions: async (boardId: string, recordId: string) => {
            await options.service.record(boardId, recordId);
            const runs = await options.journal.get<SavedRun[]>('record-runs:' + boardId) ?? [];
            return runs.filter(run => run.recordId === recordId).map(view);
        },
        async scan() {
            const errors: unknown[] = [];
            for (const board of await options.service.catalog()) {
                for (const run of await options.journal.get<SavedRun[]>('record-runs:' + board.id) ?? []) {
                    if (!['completed', 'failed'].includes(run.state)) {try {await resume(run);} catch (error) {errors.push(error);}}
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
        requireValue(frozen.sourceBoardId === boardId && frozen.recordId === request.recordId && (frozen.requestRevision ?? frozen.recordRevision) === request.expectedRevision
            && (!frozen.placement || frozen.placement === (request.placement ?? 'current-board')), 'IDEMPOTENCY_CONFLICT');
        return frozen;
    }
    requireValue(record.kind === 'decision' && record.status === 'confirmed', 'DECISION_NOT_CONFIRMED');
    requireValue(record.revision === request.expectedRevision, 'REVISION_CONFLICT');
    const board = await options.service.read(boardId);
    requireValue(board.automation, 'AUTOMATION_BINDING_REQUIRED');
    await validateRemoteReferences(options.projects, record);
    requireValue(record.externalRefs?.some(ref => ref.system === REMOTE_PROJECT_REFERENCE), 'REMOTE_PROJECT_REQUIRED');
    const id = sha256HexSync(JSON.stringify([boardId, record.id, record.revision]));
    const placement = request.placement ?? 'current-board';
    requireValue(['current-board', 'new-board'].includes(placement), 'INVALID_EXECUTION_PLACEMENT');
    const saved = await options.journal.update<SavedRun[]>('record-runs:' + boardId, previous => {
        requireValue(!previous?.some(row => row.recordId === record.id && row.state === 'completed'), 'DECISION_EXECUTION_COMPLETED');
        const same = previous?.find(row => row.id === id || row.recordId === record.id && decisionSignature(row.record) === decisionSignature(record));
        if (same) {requireValue(!same.placement || same.placement === placement, 'DECISION_EXECUTION_PLACEMENT_CONFLICT'); return previous!;}
        requireValue(!previous?.some(row => row.recordId === record.id && !['completed', 'failed'].includes(row.state)), 'DECISION_EXECUTION_UNSETTLED');
        requireValue((previous?.length ?? 0) < 100, 'RECORD_EXECUTION_LIMIT');
        return [...previous ?? [], newRun(board, record, request, id)];
    });
    await options.journal.update('record-context:'+id,old=>old??{sourceBoardId:boardId,recordId:record.id,recordRevision:record.revision,runId:id});
    const original = saved.find(row => row.id === id || row.recordId === record.id && decisionSignature(row.record) === decisionSignature(record))!;
    return freezeOperation(options, request, original);
}
function freezeOperation(options: Options, request: KanbanRecordRunRequest, run: SavedRun): Promise<SavedRun> {
    return options.journal.update<SavedRun>('record-operation:' + request.operationId, previous => {
        requireValue(!previous || previous.id === run.id && (previous.requestRevision ?? previous.recordRevision) === request.expectedRevision
            && (!previous.placement || previous.placement === (request.placement ?? 'current-board')), 'IDEMPOTENCY_CONFLICT');
        return previous ?? {...run, requestRevision: request.expectedRevision};
    });
}

async function advance(options: Options, run: SavedRun): Promise<KanbanRecordExecution> {
    const started = Date.now();
    try {
        await validateRemoteReferences(options.projects, run.record);
        await materialize(options, run);
        const board = await options.service.read(run.boardId);
        const items = run.itemIds ? await Promise.all(run.itemIds.map(async id => board.items.find(item => item.id === id) ?? (await options.service.item(run.boardId, id)).item)) : board.items;
        const state = runState(items);
        if (state === 'completed' && run.rootItemId && !run.itemIds?.includes(run.rootItemId) && board.items.find(item => item.id === run.rootItemId)?.status !== 'completed') {
            await once(options, run, 'close-root', {type: 'close-plan', itemId: run.rootItemId, resultRef: 'kanban-run:' + run.id});
        }
        const updated = await save(options, {...run, state, code: state === 'failed' ? 'DECISION_TASK_CANCELLED' : undefined, updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: state === 'failed' ? 'failure' : 'success', code: updated.code, durationMs: Date.now() - started});
        return view(updated);
    } catch (error) {
        const code = safeCode(error, 'RECORD_EXECUTION_FAILED');
        await save(options, {...run, state: 'blocked', code, updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: 'failure', code, durationMs: Date.now() - started});
        throw error;
    }
}

function decisionSignature(record: KanbanProjectRecord): string {
    return sha256HexSync(JSON.stringify([record.title, record.content, record.rationale, record.externalRefs]));
}
function newRun(board: KanbanBoard, record: KanbanProjectRecord, request: KanbanRecordRunRequest, id: string): SavedRun {
    const placement = request.placement ?? 'current-board';
    requireValue(['current-board', 'new-board'].includes(placement), 'INVALID_EXECUTION_PLACEMENT');
    requireValue(placement === 'new-board' || board.automation?.enabled, 'AUTOMATION_PAUSED');
    const refs = record.externalRefs!.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE);
    const types = board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;
    const task = types.find(type => type.id === (board.defaultWorkType ?? 'task') && type.executable) ?? types.find(type => type.executable);
    const parent = types.filter(type => !type.executable && type.rank < (task?.rank ?? 0)).sort((a, b) => b.rank - a.rank)[0];
    requireValue(task && (refs.length === 1 || parent), 'DECISION_WORK_TYPES_REQUIRED');
    const itemIds = refs.map((_, index) => 'work-' + id + '-' + index);
    return {id, sourceBoardId: board.id, recordId: record.id, recordRevision: record.revision,
        boardId: placement === 'new-board' ? 'run-' + id : board.id, placement, taskKind: task.id, parentKind: parent?.id,
        rootItemId: refs.length === 1 ? itemIds[0] : 'feature-' + id, itemIds,
        state: 'preparing', createdAt: Date.now(), updatedAt: Date.now(), record, automation: structuredClone(board.automation!)};
}
function runState(items: KanbanItem[]): KanbanRecordExecution['state'] {
    if (items.some(item => item.status === 'cancelled')) return 'failed';
    if (items.length && items.every(item => item.status === 'completed')) return 'completed';
    if (items.some(item => item.blocked)) return 'blocked';
    return items.length && items.every(item => ['completed', 'review'].includes(item.status)) ? 'review' : 'running';
}
async function materialize(options: Options, run: SavedRun): Promise<void> {
    if (run.boardId !== run.sourceBoardId) {
        const actor = await options.service.currentPrincipal(), source = await options.service.read(run.sourceBoardId);
        await options.service.create({id: run.boardId, title: run.record.title, scope: {kind: 'collection', namespace: 'decision-run', id: run.id},
            members: [{...actor, responsibility: 'Review decision execution', roles: ['coordinator', 'reviewer', 'worker']}],
            ...(run.placement && source.workTypes ? {workTypes: source.workTypes, defaultWorkType: source.defaultWorkType} : {}),
            policy: {requireEstimate: false, review: 'independent'}});
    }
    const refs = run.record.externalRefs!.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE);
    const group = !!run.rootItemId && !run.itemIds?.includes(run.rootItemId);
    if (group) await once(options, run, 'root', {type: 'create-item', item: {id: run.rootItemId!, title: run.record.title,
        responsibility: run.record.content, acceptance: run.record.rationale ?? run.record.content},
        planning: {kind: run.parentKind!, priority: 2, dependencies: [], references: []}});
    for (const [index, reference] of refs.entries()) {
        await once(options, run, 'item-' + index, {type: 'create-item', item: {id: run.itemIds?.[index] ?? 'work-' + index,
            title: run.record.title, responsibility: run.record.content, acceptance: run.record.rationale ?? run.record.content,
            externalRefs: [reference, {system: 'nestos-decision-run', id: run.id}]},
            ...(run.taskKind ? {planning: {kind: run.taskKind, priority: 2, dependencies: [], references: [], ...(group ? {parentId: run.rootItemId} : {})}} : {})});
    }
    if (run.boardId !== run.sourceBoardId) await once(options, run, 'automation', {type: 'configure-automation', settings: {...run.automation, enabled: true, autoAccept: false}});
    if (run.rootItemId && run.boardId === run.sourceBoardId) await once(options, run, 'link-root', {type: 'link-record', recordId: run.recordId, itemId: run.rootItemId});
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
    const {id, recordId, recordRevision, boardId, rootItemId, itemIds, state, createdAt, updatedAt, code} = run;
    return {id, recordId, recordRevision, boardId, ...(rootItemId ? {rootItemId, itemIds} : {}), state, createdAt, updatedAt, ...(code ? {code} : {})};
}

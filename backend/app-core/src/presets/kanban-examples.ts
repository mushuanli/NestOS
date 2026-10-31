import {proposeAmendment} from '../kanban/amendments';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {KanbanCommand, KanbanPlanning, KanbanService, KanbanWorkType} from '@itookit/app-contracts';
import type {KanbanState, KanbanStore} from '../kanban/ports';
import type {InitialFileEntry, InitialResourceProvider} from './initial-files';
import {policy} from '../kanban/configuration';
import {reduce} from '../kanban/reducer';
import {validateBoard} from '../kanban/rules';
import demo from './kanban-demo.json';
const log = createModuleLogger('kanban-examples');
const resourceId = 'kanban:nestos-demo';
const actor = {kind: 'human' as const, id: 'admin'};
interface Example {
    introduced?: number; id: string; title: string; responsibility: string; acceptance: string; planning: KanbanPlanning;
    stage?: 'backlog' | 'open'; example?: 'completed' | 'archived'; blocked?: string;
}
const examples = demo.items as Example[];

/** Product presets use one store transaction and the same domain reducer as ordinary commands. */
export class KanbanExamples implements InitialResourceProvider {
    constructor(private readonly store: KanbanStore, private readonly service?: KanbanService) {}
    async list(): Promise<InitialFileEntry[]> {
        const state = await this.store.read(demo.id), ids = new Set([...(state?.board.items ?? []), ...(state?.archiveIndex ?? [])].map(item => item.id));
        return [{id: resourceId, group: 'kanban', name: demo.title, path: `#/kanban/${encodeURIComponent('/board/' + demo.id)}`,
            exists: !!state && examples.every(item => ids.has(item.id)) && demo.records.every(record => state.records?.some(old => old.id === record.id))}];
    }
    async seed(): Promise<void> {
        const state = await this.store.read(demo.id);
        if ((state?.presetVersions?.[demo.id] ?? 0) >= demo.version) return;
        await this.install('seed', false);
    }
    async restore(id: string): Promise<boolean> {
        if (id !== resourceId) throw new Error('INITIAL_FILE_UNKNOWN');
        const changed = await this.install('restore', true);
        if (changed && this.service) await this.publish();
        return changed;
    }
    private async install(stage: 'seed' | 'restore', fillMissing: boolean): Promise<boolean> {
        const operationId = stage === 'seed' ? `preset:kanban-demo:v${demo.version}` : randomUUID(), started = Date.now(); let changed = false, created = 0;
        try {
            await this.store.update(demo.id, operationId, JSON.stringify({preset: demo.id, stage, version: demo.version}), previous => {
                const installed = previous?.presetVersions?.[demo.id] ?? (previous ? 1 : 0);
                if (previous && !fillMissing && installed >= demo.version) return previous;
                const state = previous ?? initial(); changed = !previous;
                const known = new Set([...state.board.items, ...(state.archiveIndex ?? [])].map(item => item.id));
                for (const item of examples) if (!known.has(item.id) && (fillMissing || (item.introduced ?? 1) > installed)) {insert(state, item, operationId, started); known.add(item.id); changed = true; created++;}
                if (installContext(state, operationId, started, fillMissing ? 0 : installed)) changed = true;
                (state.presetVersions ??= {})[demo.id] = demo.version;
                return state;
            });
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
function initial(): KanbanState {
    const board = {id: demo.id, title: demo.title, scope: {kind: 'system' as const}, revision: 1, items: [], participants: [],
        members: [{...actor, responsibility: demo.responsibility, roles: ['worker', 'reviewer', 'coordinator'] as Array<'worker' | 'reviewer' | 'coordinator'>}],
        workTypes: structuredClone(demo.workTypes) as KanbanWorkType[], defaultWorkType: 'task',
        policy: policy({requireEstimate: false, review: 'assignee'}), notifications: structuredClone(demo.notifications) as import('@itookit/app-contracts').KanbanNotificationPolicy};
    validateBoard(board); return {schema: 1, board, sequence: 0, events: [], escalations: []};
}
function insert(state: KanbanState, example: Example, operationId: string, now: number): void {
    const {id, title, responsibility, acceptance, planning, stage} = structuredClone(example);
    // An existing, finished parent remains untouched when recovering a missing child.
    const parent = state.board.items.find(item => item.id === planning.parentId);
    if (planning.parentId && (!parent || ['completed', 'cancelled'].includes(parent.status))) delete planning.parentId;
    const apply = (command: KanbanCommand) => reduce(state, command, actor, operationId, now, randomUUID());
    apply({type: 'create-item', item: {id, title, responsibility, acceptance}, planning, stage});
    if (example.blocked) apply({type: 'block-item', itemId: id, reason: example.blocked});
    if (example.example) apply({type: 'close-plan', itemId: id, resultRef: demo.resultRef});
    if (example.example === 'archived') apply({type: 'archive-items', itemIds: [id], reason: demo.archiveReason});
}

function installContext(state: KanbanState, operationId: string, now: number, installed: number): boolean {
    let changed = false;
    const apply = (command: import('@itookit/app-contracts').KanbanCommand) => reduce(state, command, actor, operationId, now, randomUUID());
    for (const example of demo.records) {
        if (example.introduced <= installed) continue;
        if (state.records?.some(record => record.id === example.id)) continue;
        const {confirmExample, ...record} = example as typeof example & {confirmExample?: boolean};
        apply({type: 'append-record', record: {...record, itemIds: record.itemIds.filter(id => state.board.items.some(item => item.id === id) || state.archiveIndex?.some(item => item.id === id)), kind: record.kind as 'log' | 'decision'}});
        if (confirmExample) apply({type: 'review-record', recordId: record.id, accept: true});
        changed = true;
    }
    for (const example of demo.amendments) {
        if (example.introduced <= installed) continue;
        const item = state.board.items.find(item => item.id === example.itemId); if (!item) continue;
        const count = item.amendments?.length ?? 0;
        proposeAmendment(item, {action: 'update', ...example, sources: []}, {kind: 'service', id: example.proposedBy.id}, now, example.runId);
        if ((item.amendments?.length ?? 0) > count) {item.revision++; state.board.revision++; changed = true;}
    }
    return changed;
}

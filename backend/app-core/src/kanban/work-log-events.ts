import {sha256HexSync, t} from '@itookit/common';
import type {KanbanBoard, KanbanEvent, KanbanItemSummary, KanbanProjectRecord, KanbanRecordActivity, KanbanExternalReference} from '@itookit/kanban/contracts';
import {KANBAN_EXECUTION_SESSION} from '@itookit/app-contracts';

export function eventActivity(event: KanbanEvent): KanbanRecordActivity | undefined {
    const base = {actor: {kind: event.actor.kind ?? 'agent' as const, id: event.actor.id ?? event.actor.agentId ?? 'unknown'}, result: 'success' as const, ...(event.data.dispatchId ? {dispatchId: event.data.dispatchId} : {})};
    if (event.kind === 'create-item') return {...base, stage: 'task.created'};
    if (event.kind === 'prepare-dispatch') return {...base, stage: 'execution.prepared'};
    if (event.kind === 'continue-execution') return {...base, stage: 'execution.continued'};
    if (event.kind === 'submit') return {...base, stage: 'execution.review'};
    if (event.kind === 'close-plan' || event.kind === 'review' && event.data.reason === 'accepted' || event.kind === 'accept-execution' && event.data.reason === 'accepted') return {...base, stage: 'task.completed'};
    if (event.kind === 'cancel-item' || event.kind === 'release-item' && event.data.reason === 'cancelled') return {...base, stage: 'task.cancelled', result: 'cancelled'};
    if (event.kind === 'observe-execution') {
        const result = event.data.reason?.slice('execution-'.length);
        if (result && ['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(result)) return {...base,
            stage: result === 'succeeded' && event.data.status === 'completed' ? 'task.completed' : 'execution.' + result, result: result === 'failed' || result === 'unknown' ? 'failure' : result === 'cancelled' ? 'cancelled' : 'success', code: event.data.code};
    }
    if (event.kind === 'link-reference' && event.data.reference) {
        const system = event.data.reference.system;
        const stage = system === KANBAN_EXECUTION_SESSION ? 'session.bound' : system === 'nestos-native-session' ? 'session.native' : system === 'nestos-worktree' ? 'worktree.prepared' : undefined;
        if (stage) return {...base, stage};
    }
    if (event.kind === 'message') return {...base, stage: 'task.message'};
    if (event.kind === 'block-item') return {...base, stage: 'task.blocked', result: 'failure', code: event.data.reason};
    return undefined;
}
export function activityRecord(board: Pick<KanbanBoard, 'id'>, item: KanbanItemSummary | undefined, id: string, at: number,
    activity: KanbanRecordActivity, refs: KanbanExternalReference[] = [], content?: string, ancestors: string[] = []): KanbanProjectRecord {
    const key = ('kanban.activity.' + activity.stage) as Parameters<typeof t>[0], translated = t(key), label = translated === key ? activity.stage : translated;
    return {id: 'activity-' + sha256HexSync(JSON.stringify([board.id, id])), kind: 'log', title: [item?.title, label].filter(Boolean).join(' · '),
        content: content ?? [label, activity.code, ...Object.entries(activity.fields ?? {}).map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join('\n'),
        activity, externalRefs: refs, itemIds: [...new Set([...(item ? [item.id] : []), ...ancestors])], sources: [],
        author: activity.actor ?? {kind: 'service', id: 'kanban-activity'}, origin: 'flow', status: 'confirmed', revision: 1, createdAt: at, updatedAt: at};
}
export function ancestorIds(item: KanbanItemSummary | undefined, items: KanbanItemSummary[]): string[] {
    const result: string[] = [], seen = new Set(item ? [item.id] : []); let parent = item?.planning.parentId;
    while (parent && !seen.has(parent)) {seen.add(parent); result.push(parent); parent = items.find(row => row.id === parent)?.planning.parentId;}
    return result;
}

export function lifecycleReferences(refs: KanbanExternalReference[] = []): KanbanExternalReference[] {
    return ['nestos-execution-session', 'nestos-native-session', 'nestos-worktree'].flatMap(system => {
        const ref = refs.filter(ref => ref.system === system).at(-1); return ref ? [ref] : [];
    });
}

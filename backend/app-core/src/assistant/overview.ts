import {createModuleLogger, randomUUID} from '@itookit/common';
import type {AssistantEvent, AssistantOverview, LocalApplicationServices, TwinActivitySummary} from '@itookit/app-contracts/services';
import type {SessionActivity} from '@itookit/durable-kernel/contracts';
const log = createModuleLogger('assistant-overview');
type Services = Pick<LocalApplicationServices, 'kernel' | 'sessionRepository' | 'digitalTwin'>;
interface PendingOverview {kernel: Services['kernel']['kernel']; twin: Services['digitalTwin']; result: Promise<AssistantOverview>}
const pendingOverviews = new WeakMap<Services['sessionRepository'], Set<PendingOverview>>();

/** Query existing cold projections; never opens execution Sessions or starts background work. */
export async function assistantOverview(services: Services): Promise<AssistantOverview> {
    const repository = services.sessionRepository, kernel = services.kernel.kernel, twin = services.digitalTwin;
    const pending = pendingOverviews.get(repository) ?? new Set<PendingOverview>();
    let entry = [...pending].find(item => item.kernel === kernel && item.twin === twin);
    if (!entry) {
        const result = projectOverview(services).finally(() => {
            pending.delete(created);
            if (!pending.size) pendingOverviews.delete(repository);
        });
        const created = {kernel, twin, result}; entry = created;
        pending.add(entry); pendingOverviews.set(repository, pending);
    }
    // Callers own their projection; only overlapping reads share storage work.
    return structuredClone(await entry.result);
}

async function projectOverview(services: Services): Promise<AssistantOverview> {
    const started = performance.now(), operationId = randomUUID();
    const results = await Promise.allSettled([
        readSource(operationId, 'sessions', () => sessionEvents(services)),
        readSource(operationId, 'scanners', () => scannerEvents(services)),
    ]);
    const events: AssistantEvent[] = [], scanners: AssistantOverview['scanners'] = [], unavailable: AssistantOverview['unavailable'] = [];
    for (const [index, result] of results.entries()) {
        const source = index === 0 ? 'sessions' : 'scanners';
        if (result.status === 'rejected') {
            unavailable.push(source);
        } else {events.push(...result.value.events); if ('scanners' in result.value) scanners.push(...result.value.scanners);}
    }
    events.sort((a, b) => a.priority - b.priority || b.at - a.at || a.id.localeCompare(b.id));
    log.info('assistant.overview', {operationId, stage: 'project', result: unavailable.length ? 'partial' : 'success', count: events.length, durationMs: Math.round(performance.now() - started)});
    return {events, scanners, unavailable};
}

async function readSource<T extends {events: AssistantEvent[]}>(operationId: string, stage: string, read: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
        const result = await read();
        log.info('assistant.overview', {operationId, stage, result: 'success', count: result.events.length, durationMs: Math.round(performance.now() - started)});
        return result;
    } catch (error) {
        log.warn('assistant.overview', {operationId, stage, result: 'failure', code: 'ASSISTANT_SOURCE_UNAVAILABLE',
            errorType: error instanceof Error ? error.name : typeof error, durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}
async function sessionEvents(services: Services): Promise<{events: AssistantEvent[]}> {
    const repository = services.sessionRepository, kernel = services.kernel.kernel;
    if (!kernel.sessionActivity) return {events: []};
    const summaries = await (repository.listSummaries?.() ?? repository.list()), byId = new Map(summaries.map(item => [item.id, item]));
    const sessions = []; for await (const session of kernel.listSessions()) if (byId.has(session.id)) sessions.push(session);
    const events: AssistantEvent[] = [];
    for (let offset = 0; offset < sessions.length; offset += 8) {
        const rows = await Promise.all(sessions.slice(offset, offset + 8).map(async session => {
            try {return sessionEvent(session.id, byId.get(session.id)!.title, session.updatedAt, await kernel.sessionActivity!(session.id));}
            catch (error) {if (['ENOENT', 'SESSION_NOT_FOUND'].includes(String((error as {code?: string}).code))) return; throw error;}
        }));
        events.push(...rows.filter((item): item is AssistantEvent => !!item));
    }
    return {events};
}
export function sessionEvent(id: string, title: string, at: number, activity: SessionActivity): AssistantEvent | undefined {
    const base = {id: 'session:' + id, source: 'sessions' as const, title, at, target: {target: 'chat' as const, resourceId: id}};
    if (activity.pending.approval) return {...base, kind: 'approval', priority: 0, requiresAction: true, revision: 'approval:' + activity.pending.approval};
    if (activity.pending.input) return {...base, kind: 'input', priority: 0, requiresAction: true, revision: 'input:' + activity.pending.input};
    if (activity.counts.blocked) return {...base, kind: 'blocked', priority: 1, requiresAction: true, revision: 'blocked:' + activity.counts.blocked};
    if (!activity.latestExit || ['running', 'created', 'queued', 'waiting', 'paused'].some(phase => activity.counts[phase as keyof typeof activity.counts] > 0)) return;
    const exit = activity.latestExit;
    if (exit.status === 'cancelled') return;
    return {...base, at: exit.at, kind: exit.status === 'failed' ? 'failure' : 'completion', priority: exit.status === 'failed' ? 2 : 4,
        requiresAction: false, revision: exit.status + ':' + exit.at};
}
async function scannerEvents(services: Services) {
    const twin = services.digitalTwin;
    if (!twin?.activitySummary) return {events: [] as AssistantEvent[], scanners: [] as AssistantOverview['scanners']};
    const spaces = await twin.workspaces(), summaries: TwinActivitySummary[] = [];
    for (const space of spaces) summaries.push(await (await twin.openWorkspace(space.id)).activitySummary!());
    return {scanners: summaries.flatMap(summary => summary.plans.map(plan => ({...plan, workspaceId: summary.workspace.id, workspaceName: summary.workspace.name}))),
        events: summaries.flatMap(summary => summary.runs.flatMap(run => {
            const kind = run.state === 'succeeded' ? 'scanCompletion' : ['failed', 'interrupted'].includes(run.state) ? 'scanFailure' : run.state === 'paused' ? 'scanPaused' : undefined;
            if (!kind) return [];
            return [{id: `scanner:${summary.workspace.id}:${run.planId}`, revision: run.id + ':' + run.state, source: 'scanners' as const, kind,
                title: run.name, at: run.at, priority: kind === 'scanCompletion' ? 4 : 2, requiresAction: kind === 'scanPaused',
                target: {target: 'twin' as const, resourceId: `/workspace/${encodeURIComponent(summary.workspace.id)}/runs/${encodeURIComponent(run.id)}`}} satisfies AssistantEvent];
        }))};
}

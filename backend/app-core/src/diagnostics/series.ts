import type {DiagnosticEvent, DiagnosticSeries} from '@itookit/app-contracts/services';

const maxGapMs = 5 * 60 * 1000;
const scope = (v: DiagnosticEvent) => JSON.stringify([v.module, v.stage, v.projectId, v.connectionId, v.mountId, v.profileId, v.sessionId]);
const signature = (v: DiagnosticEvent) => JSON.stringify([v.operation, v.result, v.level, v.code, v.reason, v.rpcCode, v.causeCodes]);
const attempt = (v: DiagnosticEvent) => JSON.stringify([scope(v), v.operation, v.operationId]);
type Change = (event: DiagnosticEvent, removed?: boolean) => void;

/** Independent sources may interleave; a recovery or changed error ends only its own series. */
export class DiagnosticSeriesTracker {
    private terminal = new Map<string, DiagnosticEvent>();
    private started = new Map<string, DiagnosticEvent>();
    remove(event: DiagnosticEvent): void {
        if (this.terminal.get(scope(event)) === event) this.terminal.delete(scope(event));
        if (this.started.get(attempt(event)) === event) this.started.delete(attempt(event));
    }
    close(events: DiagnosticEvent[], match: Partial<Pick<DiagnosticEvent, 'projectId' | 'connectionId' | 'mountId' | 'profileId' | 'sessionId'>>,
        time: number, ending: DiagnosticSeries['ending'], dirty: (event: DiagnosticEvent) => void): void {
        for (const event of events) {
            if (!Object.entries(match).every(([key, value]) => event[key as keyof typeof match] === value)) continue;
            this.end(event, time, ending, dirty); this.remove(event);
        }
    }
    add(events: DiagnosticEvent[], event: DiagnosticEvent, dirty: Change): DiagnosticEvent {
        const key = event.result === 'started' ? attempt(event) : scope(event), source = event.result === 'started' ? this.started : this.terminal;
        if (event.result !== 'started') this.complete(events, event, dirty);
        const previous = source.get(key), retained = previous && events.includes(previous);
        if (retained && previous.series?.endedAt === undefined && signature(previous) === signature(event)
            && event.timestamp - previous.timestamp <= maxGapMs && event.timestamp >= previous.timestamp) {
            merge(previous, event); events.splice(events.indexOf(previous), 1); events.push(previous); dirty(previous); return previous;
        }
        if (retained) this.end(previous, event.timestamp, previous.result === 'failure' && event.result === 'success' ? 'recovered' : 'changed', dirty);
        event.series ??= initial(event); events.push(event); source.set(key, event); dirty(event); return event;
    }
    private complete(events: DiagnosticEvent[], event: DiagnosticEvent, dirty: Change): void {
        const ids = new Set([event.operationId, event.series?.firstOperationId, ...(event.series?.samples.map(sample => sample.operationId) ?? [])]);
        for (const operationId of ids) {
            if (!operationId) continue;
            const key = attempt({...event, operationId}), started = this.started.get(key);
            if (!started || !events.includes(started) || (started.series?.count ?? 1) !== 1 || started.timestamp > event.timestamp) continue;
            if (operationId === event.operationId) {
                event.startedAt = started.startedAt ?? started.timestamp;
                event.durationMs ??= event.timestamp - event.startedAt;
                if (event.id !== started.id) dirty(event, true);
                event.id = started.id;
            }
            events.splice(events.indexOf(started), 1); this.started.delete(key); dirty(started, true);
        }
    }
    private end(event: DiagnosticEvent | undefined, time: number, ending: DiagnosticSeries['ending'], dirty: (event: DiagnosticEvent) => void): void {
        if (!event || event.series?.endedAt !== undefined) return;
        event.series ??= initial(event); event.series.endedAt = Math.max(time, event.series.lastAt); event.series.ending = ending; dirty(event);
    }
}
export function initial(event: DiagnosticEvent): DiagnosticSeries {
    return {count: 1, firstAt: event.timestamp, lastAt: event.timestamp, firstOperationId: event.operationId,
        ...(event.requestId ? {firstRequestId: event.requestId} : {}), samples: [sample(event)],
        ...(event.durationMs !== undefined ? {minDurationMs: event.durationMs, maxDurationMs: event.durationMs, totalDurationMs: event.durationMs} : {})};
}
function sample(event: DiagnosticEvent) {return {timestamp: event.timestamp, operationId: event.operationId,
    ...(event.requestId ? {requestId: event.requestId} : {}), ...(event.durationMs !== undefined ? {durationMs: event.durationMs} : {})};}
function merge(previous: DiagnosticEvent, event: DiagnosticEvent): void {
    const series = previous.series ??= initial(previous);
    series.count = Math.min(Number.MAX_SAFE_INTEGER, series.count + 1); series.lastAt = event.timestamp; series.samples = [...series.samples.slice(-4), sample(event)];
    if (event.durationMs !== undefined) {
        series.minDurationMs = Math.min(series.minDurationMs ?? Infinity, event.durationMs);
        series.maxDurationMs = Math.max(series.maxDurationMs ?? 0, event.durationMs);
        series.totalDurationMs = Math.min(Number.MAX_SAFE_INTEGER, (series.totalDurationMs ?? 0) + event.durationMs);
    }
    Object.assign(previous, event, {id: previous.id, series});
}

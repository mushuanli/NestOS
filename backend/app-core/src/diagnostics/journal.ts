import {createModuleLogger, randomUUID} from '@itookit/common';
import {type IFileSystem} from '@itookit/vfs-core';
import type {ApplicationDiagnostics, DiagnosticEvent, DiagnosticPage, DiagnosticQuery} from '@itookit/app-contracts/services';

import {DiagnosticStore, maxEntries, maxBytes} from './store';
import {DiagnosticSeriesTracker, initial} from './series';
import {clean} from './codec';
type Input = Omit<DiagnosticEvent, 'id' | 'timestamp' | 'operationId' | 'series'> & {operationId?: string};
const log = createModuleLogger('application-diagnostics');

/** One journal per application runtime, including when several users share a Node process. */
export class DiagnosticJournal implements ApplicationDiagnostics {
    private events: DiagnosticEvent[] = [];
    private listeners = new Set<() => void>();
    private store?: DiagnosticStore;
    private tracker = new DiagnosticSeriesTracker();
    private changes = new Map<string, string | null>();
    private persistence: DiagnosticPage['persistence'] = 'memory';
    private persistenceError?: DiagnosticPage['persistenceError'];
    private pending?: Promise<void>;
    private dirty = false;
    private closed = false;

    record(input: Input): DiagnosticEvent {
        const event = clean({...input, id: randomUUID(), operationId: input.operationId ?? randomUUID(), timestamp: Date.now()});
        const aggregated = this.tracker.add(this.events, event, (entry, removed) => this.changes.set(entry.id, removed ? null : JSON.stringify(entry)));
        this.trim(); this.dirty = true;
        const data = {...aggregated};
        log[event.level](event.operation, data);
        if (event.result === 'failure') console.warn('[ApplicationDiagnostic]', data);
        this.notify(); this.schedule(); return structuredClone(aggregated);
    }
    async query(query: DiagnosticQuery = {}): Promise<DiagnosticPage> {
        const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 100) || 100));
        const search = typeof query.search === 'string' ? query.search.slice(0, 200).toLowerCase() : '';
        const events = this.events.filter(event => (!query.projectId || event.projectId === query.projectId)
            && (!query.connectionId || event.connectionId === query.connectionId) && (!query.module || event.module === query.module)
            && (!query.level || event.level === query.level)
            && (query.startTime === undefined || event.timestamp >= query.startTime)
            && (query.endTime === undefined || (event.series?.firstAt ?? event.timestamp) <= query.endTime) && (!search || JSON.stringify(event).toLowerCase().includes(search)));
        const requested = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
        const offset = Math.min(requested, Math.max(0, Math.ceil(events.length / limit) - 1) * limit);
        return {events: structuredClone(events.slice().reverse().slice(offset, offset + limit)), retained: this.events.length, limit, offset, matchingGroups: events.length,
            totalOccurrences: this.events.reduce((sum, event) => Math.min(Number.MAX_SAFE_INTEGER, sum + (event.series?.count ?? 1)), 0),
            matchingOccurrences: events.reduce((sum, event) => Math.min(Number.MAX_SAFE_INTEGER, sum + (event.series?.count ?? 1)), 0),
            truncated: events.length > offset + limit, persistence: this.persistence, persistenceError: this.persistenceError ? {...this.persistenceError} : undefined};
    }
    onChange(listener: () => void): () => void { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; }
    async attach(fs: IFileSystem): Promise<void> {
        this.store = new DiagnosticStore(fs);
        try {
            const saved = await this.store.load(), pending = this.events;
            this.events = []; this.tracker = new DiagnosticSeriesTracker();
            const old = new DiagnosticSeriesTracker();
            for (const event of saved) old.add(this.events, event, (entry, removed) => {if (removed) this.changes.set(entry.id, null);});
            for (const event of this.events) {
                event.series ??= initial(event);
                if (event.series.endedAt === undefined) {event.series.endedAt = event.series.lastAt; event.series.ending = 'restarted';}
                this.changes.set(event.id, JSON.stringify(event));
            }
            for (const event of pending) this.tracker.add(this.events, event, (entry, removed) => this.changes.set(entry.id, removed ? null : JSON.stringify(entry)));
            this.trim(); this.persistence = 'ready'; this.dirty = true; this.schedule();
        } catch (error) {this.persistence = 'unavailable'; this.storageFailure(error, 'load');}
    }
    endSource(match: Partial<Pick<DiagnosticEvent, 'projectId' | 'connectionId' | 'mountId' | 'profileId' | 'sessionId'>>, ending: 'changed' | 'recovered' | 'restarted' = 'changed'): void {
        this.tracker.close(this.events, match, Date.now(), ending, event => this.changes.set(event.id, JSON.stringify(event)));
        this.dirty = true; this.notify(); this.schedule();
    }
    async dispose(): Promise<void> {
        if (this.closed) return;
        this.endSource({}, 'restarted'); await this.flush(); this.closed = true; this.listeners.clear();
    }
    async flush(): Promise<void> { do {this.schedule(); await this.pending;} while (this.pending); }
    private schedule(): void {
        if (this.closed || this.pending || !this.store || this.persistence !== 'ready') return;
        this.pending = Promise.resolve().then(async () => {
            while (this.dirty) {
                this.dirty = false;
                const changes = this.changes; this.changes = new Map();
                const snapshot = this.events.slice();
                try {await this.store!.save(snapshot, changes);}
                catch (error) {this.persistence = 'unavailable'; this.storageFailure(error, 'write'); break;}
            }
        }).finally(() => {this.pending = undefined; if (this.dirty) this.schedule();});
    }
    private trim(): void {
        while (this.events.length > maxEntries || JSON.stringify(this.events).length * 2 > maxBytes) {
            const removed = this.events.shift()!; this.tracker.remove(removed); this.changes.set(removed.id, null);
        }
    }
    private notify(): void { for (const listener of this.listeners) {try {listener();} catch { /* Observers cannot break an operation. */ }} }
    private storageFailure(error: unknown, stage: 'load' | 'write'): void {
        const raw = (error as {code?: unknown})?.code;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : error instanceof SyntaxError ? 'DIAGNOSTIC_FORMAT_INVALID' : 'DIAGNOSTIC_STORAGE_UNAVAILABLE';
        this.persistenceError = {stage, code}; console.warn('[ApplicationDiagnostic]', {operation: 'diagnostics.persist', stage, result: 'failure', code}); this.notify();
    }
}

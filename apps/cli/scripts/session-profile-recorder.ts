import {AsyncLocalStorage} from 'node:async_hooks';
import {Session} from 'node:inspector';
import {writeFile} from 'node:fs/promises';
import type {ISidecarDb} from '@itookit/vfsdriver-local';
import type {IRecordStore} from '@itookit/vfs-core';

interface Span {name: string; scenario: string; api?: string; start: number; duration: number}
interface TransactionShape {count: number; scenario: string; api?: string; outcome: string; accesses: string[]}
export class SessionProfileRecorder {
    private readonly context = new AsyncLocalStorage<string>();
    private readonly api = new AsyncLocalStorage<string>();
    private readonly inspector = new Session();
    private readonly spans: Span[] = [];
    private readonly transactions = new Map<string, TransactionShape>();
    private current?: {scenario: string; api?: string; accesses: string[]};
    private active = false;
    async start(): Promise<void> {
        this.inspector.connect(); await this.post('Profiler.enable');
        await this.post('Profiler.setSamplingInterval', {interval: 100});
        await this.post('Profiler.start'); this.active = true;
    }
    async stop(directory: string): Promise<void> {
        this.active = false;
        try {
            const result = await this.post('Profiler.stop');
            await writeFile(`${directory}/cpu.cpuprofile`, JSON.stringify(result.profile));
            await writeFile(`${directory}/wait-trace.json`, JSON.stringify({traceEvents: this.spans.map(span => ({
                name: span.name, cat: span.scenario, ph: 'X', pid: 1, tid: ['alone', 'overview', 'storage'].indexOf(span.scenario) + 1,
                ts: span.start * 1000, dur: span.duration * 1000, args: {},
            }))}));
            await writeFile(`${directory}/spans.json`, JSON.stringify(this.spans));
            await writeFile(`${directory}/storage-transactions.json`, JSON.stringify([...this.transactions.values()].sort((a, b) => b.count - a.count), null, 2));
        } finally {this.inspector.disconnect();}
    }
    scenario<T>(name: string, run: () => Promise<T>): Promise<T> {return this.context.run(name, run);}
    async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
        const start = performance.now();
        const execute = async () => {try {return await run();} finally {this.record(name, start);}};
        return name.startsWith('api.') ? this.api.run(name, execute) : execute();
    }
    record(name: string, start: number): void {
        if (this.active) this.spans.push({name, scenario: this.context.getStore() ?? 'background', api: this.api.getStore(), start, duration: performance.now() - start});
    }
    records(store: IRecordStore): IRecordStore {
        return new Proxy(store, {get: (target, key) => {
            const method = Reflect.get(target, key, target);
            if (key === 'transaction') return (read: Parameters<NonNullable<IRecordStore['transaction']>>[0]) => {
                const queued = performance.now();
                return target.transaction!(tx => {
                    this.record('record.transaction.admission', queued);
                    return this.measure('record.transaction.held', () => read(tx));
                });
            };
            return typeof method === 'function' ? method.bind(target) : method;
        }});
    }
    database(db: ISidecarDb): ISidecarDb {
        return new Proxy(db, {get: (target, key) => {
            const method = Reflect.get(target, key, target);
            if (typeof method !== 'function') return method;
            return async (...args: unknown[]) => {
                if (this.active) this.access(String(key), args);
                const result = await this.measure(`sqlite.${String(key)}`, () => method.apply(target, args));
                if (this.active && (key === 'commit' || key === 'rollback')) this.finishTransaction(String(key));
                return result;
            };
        }});
    }
    private access(operation: string, args: unknown[]): void {
        if (operation === 'begin') {
            this.current = {scenario: this.context.getStore() ?? 'background', api: this.api.getStore(), accesses: []}; return;
        }
        if (!this.current || ['commit', 'rollback'].includes(operation)) return;
        const metadata = args.slice(0, 2).filter((value): value is string => typeof value === 'string')
            .map(value => value.replace(/node-[0-9A-Z]{26}/g, '<session>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
                .replace(/round-\d+|entry-\d+/g, '<item>').slice(0, 180));
        this.current.accesses.push([operation, ...metadata].join(' '));
    }
    private finishTransaction(outcome: string): void {
        if (!this.current) return;
        const shape = {...this.current, outcome}, key = JSON.stringify(shape), previous = this.transactions.get(key);
        if (previous) previous.count++; else this.transactions.set(key, {...shape, count: 1});
        this.current = undefined;
    }
    post(method: string, params: object = {}): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => this.inspector.post(method, params, (error, result) => {
            if (error) reject(error); else resolve(result as Record<string, unknown>);
        }));
    }
}

import type { IRecordTransaction, RecordFieldRequest, RecordValue, RecordWalkOptions } from '@itookit/vfs-core';
import { FSError } from '@itookit/vfs-core';
import type { Cell, Commit, Mutation, Observation, Page } from '../protocol';
import { MAX_BATCH, MAX_PAGE } from '../protocol';
import type { HttpTransport } from './transport';

export async function visit(page: Page, callback: (field: string, value: RecordValue) => boolean | Promise<boolean>) {
    let processed = 0;
    for (const row of page.rows) {
        if (!await callback(row.field, row.value)) break;
        processed++;
    }
    return { total: page.total, processed };
}

export class HttpRecordTransaction implements IRecordTransaction {
    private readonly observations: Observation[] = [];
    private readonly mutations = new Map<string, Mutation>();
    private active = true;
    private readonly reads = new Map<string, Cell>();
    constructor(private readonly transport: HttpTransport) {}

    async getRecordField(path: string, field: string): Promise<RecordValue | undefined> {
        return (await this.getRecordFieldsMany([{ path, field }]))[0];
    }

    async getRecordFields(path: string, fields: string[]): Promise<Record<string, RecordValue>> {
        const values = await this.getRecordFieldsMany(fields.map(field => ({ path, field })));
        return Object.fromEntries(fields.flatMap((field, i) => values[i] === undefined ? [] : [[field, values[i]]]));
    }

    async getRecordFieldsMany(requests: ReadonlyArray<RecordFieldRequest>): Promise<Array<RecordValue | undefined>> {
        this.check();
        const unique = new Map(requests.map(request => [key(request.path, request.field), request]));
        const missing = [...unique.values()].filter(request => {
            const id = key(request.path, request.field);
            return !this.mutations.has(id) && !this.reads.has(id);
        });
        const cells = missing.length ? await this.transport.call<Cell[]>('records.getMany', [missing]) : [];
        if (missing.length) {
            this.observations.push({ kind: 'get', requests: [...missing], values: structuredClone(cells) });
            missing.forEach((request, index) => this.reads.set(key(request.path, request.field), cells[index]));
        }
        return requests.map(request => {
            const id = key(request.path, request.field);
            return structuredClone((this.mutations.get(id)?.value ?? this.reads.get(id) ?? [])[0]);
        });
    }

    async setRecordField(path: string, field: string, value: RecordValue): Promise<void> {
        this.change({ path, field, value: [structuredClone(value)] });
    }

    async deleteRecordField(path: string, field: string): Promise<void> {
        this.change({ path, field, value: [] });
    }

    async walkRecordFields(path: string, callback: (field: string, value: RecordValue) => boolean | Promise<boolean>, options?: RecordWalkOptions) {
        this.check();
        const writes = [...this.mutations.values()].filter(row => row.path === path && row.field.startsWith(options?.prefix ?? ''));
        const readOptions = writes.length ? { prefix: options?.prefix, limit: MAX_PAGE } : options;
        const page = await this.transport.call<Page>('records.walk', [path, readOptions]);
        this.observations.push({ kind: 'walk', path, options: readOptions, page: structuredClone(page) });
        if (!writes.length) return visit(page, callback);
        if (page.total > page.rows.length) throw new FSError('EFBIG', 'Transaction range exceeds the HTTP page limit');
        const rows = new Map(page.rows.map(row => [row.field, row.value]));
        for (const row of writes) { if (row.value.length) rows.set(row.field, row.value[0]); else rows.delete(row.field); }
        const ordered = [...rows].sort(([a], [b]) => compareFields(a, b)).map(([field, value]) => ({ field, value }));
        const offset = options?.offset ?? 0;
        return visit({ total: ordered.length, rows: ordered.slice(offset, offset + (options?.limit ?? ordered.length)) }, callback);
    }

    async commit(): Promise<void> {
        this.check(); this.active = false;
        if (!this.observations.length && !this.mutations.size) return;
        const payload: Commit = { observations: this.observations, mutations: [...this.mutations.values()] };
        await this.transport.call('records.commit', [payload]);
    }

    abort(): void { this.active = false; }
    private check(): void { if (!this.active) throw new FSError('EINVAL', 'Record transaction has finished'); }
    private change(row: Mutation): void {
        this.check(); this.mutations.set(key(row.path, row.field), row);
        if (this.mutations.size > MAX_BATCH) throw new FSError('EFBIG', 'HTTP transaction batch is too large');
    }
}

function key(path: string, field: string): string { return JSON.stringify([path, field]); }


function compareFields(a: string, b: string): number {
    const encoder = new TextEncoder(), left = encoder.encode(a), right = encoder.encode(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
}

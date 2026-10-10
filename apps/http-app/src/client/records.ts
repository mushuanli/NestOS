import type { IRecordStore, IRecordTransaction, RecordFieldRequest, RecordQuery, RecordQueryOptions,
    RecordQueryResult, RecordValue, RecordWalkOptions } from '@itookit/vfs-core';
import type { Cell, Page } from '../protocol';
import { HttpRecordTransaction, visit } from './record-transaction';
import type { HttpTransport } from './transport';

export class HttpRecordStore implements IRecordStore {
    constructor(private readonly transport: HttpTransport) {}
    async getRecordField(path: string, field: string): Promise<RecordValue | undefined> {
        return (await this.getRecordFieldsMany([{ path, field }]))[0];
    }
    async getRecordFields(path: string, fields: string[]): Promise<Record<string, RecordValue>> {
        const values = await this.getRecordFieldsMany(fields.map(field => ({ path, field })));
        return Object.fromEntries(fields.flatMap((field, i) => values[i] === undefined ? [] : [[field, values[i]]]));
    }
    async getRecordFieldsMany(requests: ReadonlyArray<RecordFieldRequest>): Promise<Array<RecordValue | undefined>> {
        return (await this.transport.call<Cell[]>('records.getMany', [requests])).map(cell => cell[0]);
    }
    setRecordField(path: string, field: string, value: RecordValue): Promise<void> {
        return this.transport.call('records.setRecordField', [path, field, value]);
    }
    deleteRecordField(path: string, field: string): Promise<void> {
        return this.transport.call('records.deleteRecordField', [path, field]);
    }
    setAllRecordFields(path: string, fields: Record<string, RecordValue>): Promise<void> {
        return this.transport.call('records.setAllRecordFields', [path, fields]);
    }
    clearRecordFields(path: string): Promise<void> { return this.transport.call('records.clearRecordFields', [path]); }
    createRecordIndex(path: string, field: string): Promise<void> { return this.transport.call('records.createRecordIndex', [path, field]); }
    deleteRecordIndex(path: string, field: string): Promise<void> { return this.transport.call('records.deleteRecordIndex', [path, field]); }
    queryRecordFields(path: string, query: RecordQuery, options?: RecordQueryOptions): Promise<RecordQueryResult[]> {
        return this.transport.call('records.queryRecordFields', [path, query, options]);
    }
    async walkRecordFields(path: string, callback: (field: string, value: RecordValue) => boolean | Promise<boolean>, options?: RecordWalkOptions) {
        return visit(await this.transport.call<Page>('records.walk', [path, options]), callback);
    }
    async walkRecordFieldNames(path: string, callback: (field: string) => boolean | Promise<boolean>, options?: { prefix?: string; limit?: number }): Promise<number> {
        return (await this.walkRecordFields(path, field => callback(field), options)).processed;
    }
    async transaction<T>(operation: (tx: IRecordTransaction) => Promise<T>): Promise<T> {
        const tx = new HttpRecordTransaction(this.transport);
        try { const result = await operation(tx); await tx.commit(); return result; }
        finally { tx.abort(); }
    }
}

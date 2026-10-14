import { randomUUID } from '@itookit/common';
import { validateData } from './validation';
import type { TwinRecord, TwinRecordFamily, TwinRecordWrite, TwinStore } from './contracts';

export interface TwinDataRecord<T> { id: string; revision: string; data: T; }

/** All payloads are host-validated before this persistence boundary. */
export class TwinRecords {
    constructor(readonly store: TwinStore) {}
    async get<T>(family: TwinRecordFamily, id: string): Promise<TwinDataRecord<T> | null> {
        const record = await this.store.read({ family, id });
        return record ? decoded<T>(record) : null;
    }
    async list<T>(family: TwinRecordFamily): Promise<TwinDataRecord<T>[]> {
        const result: TwinDataRecord<T>[] = [];
        for (let offset = 0; offset <= 10000; offset += 100) {
            const page = await this.store.list(family, { offset, limit: 100 });
            result.push(...page.map(decoded<T>));
            if (page.length < 100) return result;
        }
        throw new Error('TWIN_RECORD_LIMIT');
    }
    async save<T>(family: TwinRecordFamily, id: string, data: T, expectedRevision: string | null,
        conditions: Array<{ family: TwinRecordFamily; id: string; expectedRevision: string | null }> = []) {
        const current = await this.store.inspect();
        return this.store.commit({ operationId: randomUUID(), expectedForgetEpoch: current.forgetEpoch,
            writes: [write(family, id, data, expectedRevision)], conditions });
    }
}

export function write<T>(family: TwinRecordFamily, id: string, data: T, expectedRevision: string | null): TwinRecordWrite {
    return { family, id, expectedRevision, payload: JSON.parse(JSON.stringify(data)) as Record<string, unknown> };
}
function decoded<T>(record: TwinRecord): TwinDataRecord<T> {
    validateData(record.family, record.payload);
    return { id: record.id, revision: record.revision, data: record.payload as T };
}

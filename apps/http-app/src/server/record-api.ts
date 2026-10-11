import { FSError, type IRecordStore, type IRecordTransaction, type RecordFieldRequest,
    type RecordWalkOptions } from '@itookit/vfs-core';
import { MAX_BATCH, MAX_PAGE, type Cell, type Commit, type Page } from '../protocol';
import type { PathGuard } from './path-guard';
import { RecordConflictError } from './record-conflict';

export async function readMany(store: IRecordTransaction, requests: ReadonlyArray<RecordFieldRequest>): Promise<Cell[]> {
    const values = store.getRecordFieldsMany ? await store.getRecordFieldsMany(requests)
        : await Promise.all(requests.map(row => store.getRecordField(row.path, row.field)));
    return values.map(value => value === undefined ? [] : [value]);
}

export async function readPage(store: IRecordTransaction, path: string, options?: RecordWalkOptions): Promise<Page> {
    const limit = options?.limit ?? MAX_PAGE, offset = options?.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0
        || (options?.prefix !== undefined && typeof options.prefix !== 'string')) throw new FSError('EINVAL', 'Invalid record page');
    if (limit > MAX_PAGE) throw new FSError('EFBIG', 'Record page exceeds the HTTP limit');
    const rows: Page['rows'] = [];
    const result = await store.walkRecordFields(path, (field, value) => { rows.push({ field, value }); return true; }, { ...options, limit, offset });
    if (options?.limit === undefined && result.total - offset > MAX_PAGE) throw new FSError('EFBIG', 'Use bounded record pages');
    return { rows, total: result.total };
}

export async function validateRequests(guard: PathGuard, input: unknown): Promise<RecordFieldRequest[]> {
    if (!Array.isArray(input)) throw new FSError('EINVAL', 'Invalid record batch');
    if (input.length > MAX_BATCH) throw new FSError('EFBIG', 'Record batch exceeds the HTTP limit');
    return Promise.all(input.map(async row => {
        if (!row || typeof row.field !== 'string') throw new FSError('EINVAL', 'Invalid record field');
        return { path: await guard.check(row.path), field: row.field };
    }));
}

export async function commitRecords(store: IRecordStore, guard: PathGuard, input: Commit): Promise<void> {
    if (!input || !Array.isArray(input.observations) || !Array.isArray(input.mutations)) throw new FSError('EINVAL', 'Invalid transaction');
    if (input.observations.length > MAX_BATCH || input.mutations.length > MAX_BATCH) throw new FSError('EFBIG', 'Transaction exceeds the HTTP limit');
    for (const read of input.observations) {
        if (read.kind === 'get') await validateRequests(guard, read.requests);
        else if (read.kind === 'walk') await guard.check(read.path);
        else throw new FSError('EINVAL', 'Invalid transaction observation');
    }
    await validateRequests(guard, input.mutations);
    if (input.mutations.some(row => !Array.isArray(row.value) || row.value.length > 1)) throw new FSError('EINVAL', 'Invalid record value');
    if (!store.transaction) throw new FSError('ECAPABILITY', 'Atomic records are unavailable');
    await store.transaction(async tx => {
        for (const [index, read] of input.observations.entries()) {
            const current = read.kind === 'get' ? await readMany(tx, read.requests) : await readPage(tx, read.path, read.options);
            const expected = read.kind === 'get' ? read.values : read.page;
            if (JSON.stringify(current) !== JSON.stringify(expected)) throw new RecordConflictError(input, index, current);
        }
        for (const row of input.mutations) {
            if (row.value.length) await tx.setRecordField(row.path, row.field, row.value[0]);
            else await tx.deleteRecordField(row.path, row.field);
        }
    });
}

import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NodeSqliteSidecarDb} from '@itookit/node-host/storage';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function open() {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-sql-cache-'));
    cleanup.push(() => rm(directory, {recursive: true, force: true}));
    const sidecar = await NodeSqliteSidecarDb.open(path.join(directory, 'index.db'));
    cleanup.push(() => sidecar.close());
    const native = (sidecar as unknown as {db: {prepare(sql: string): unknown}}).db;
    return {sidecar, prepare: vi.spyOn(native, 'prepare')};
}

it('reuses SQL compilation while reading fresh values and preserving rollback', async () => {
    const {sidecar, prepare} = await open();
    await sidecar.setRecordField('/a.seq', 'value', 1);
    expect(await sidecar.getRecordField('/a.seq', 'value')).toBe(1);
    await sidecar.begin(); await sidecar.setRecordField('/a.seq', 'value', 2);
    expect(await sidecar.getRecordField('/a.seq', 'value')).toBe(2);
    await sidecar.rollback();
    expect(await sidecar.getRecordField('/a.seq', 'value')).toBe(1);
    await sidecar.setRecordField('/b.seq', 'other', 3);
    expect(await sidecar.getRecordField('/b.seq', 'other')).toBe(3);
    expect(prepare).toHaveBeenCalledTimes(2);
});

it('bounds the cache for variable-size batch SQL and recompiles evicted shapes', async () => {
    const {sidecar, prepare} = await open();
    for (let size = 1; size <= 140; size++) await sidecar.getRecordFieldsMany(
        Array.from({length: size}, (_, i) => ({path: '/fixture.seq', field: `field-${i}`})));
    expect((sidecar as unknown as {statements: Map<string, unknown>}).statements.size).toBe(128);
    expect(prepare).toHaveBeenCalledTimes(140);
    await sidecar.getRecordFieldsMany([{path: '/fixture.seq', field: 'field-0'}]);
    expect(prepare).toHaveBeenCalledTimes(141);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';

describe('NodeSqliteSidecarDb', () => {
    it('persists records and rolls back transactions', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'mindos-sqlite-'));
        const file = path.join(directory, 'index.db');
        const first = await NodeSqliteSidecarDb.open(file);
        await first.setRecordField('/task', 'stable', { value: 1 });
        await first.begin();
        await first.setRecordField('/task', 'temporary', true);
        await first.rollback();
        await first.close();

        const second = await NodeSqliteSidecarDb.open(file);
        expect(await second.getRecordField('/task', 'stable')).toEqual({ value: 1 });
        expect(await second.getRecordField('/task', 'temporary')).toBeUndefined();
        expect(await second.healthCheck()).toEqual({ ok: true });
        await second.close();
    });
});

import { afterEach, expect, it, vi } from 'vitest';
import { TauriSqlSidecarDb } from '../../../apps/tauri-app/src/db/tauri-sql-sidecar';

afterEach(() => vi.unstubAllGlobals());
it('closes only the selected sidecar pool', async () => {
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_database_select') return [];
        return true;
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const db = await TauriSqlSidecarDb.open('/data/isolated/meta.sqlite');
    await db.close();
    expect(invoke).toHaveBeenCalledWith('sidecar_close_database', {
        database: 'sqlite:/data/isolated/meta.sqlite', scope: 1,
    }, undefined);
});

it.each(['schema-read', 'schema-write'])('closes only its pool after %s fails during open', async stage => {
    const failure = new Error(stage);
    const pools = new Set<string>();
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_open_database') { pools.add(params.database); return false; }
        if (command === 'sidecar_close_database') { pools.delete(params.database); return true; }
        if (!pools.has(params.database)) throw new Error('Pool is closed');
        if (params.database.endsWith('broken.sqlite') && command === (stage === 'schema-read' ? 'sidecar_database_select' : 'sidecar_database_execute')) throw failure;
        return command === 'sidecar_database_select' ? [] : { rowsAffected: 0, lastInsertId: 0 };
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const peer = await TauriSqlSidecarDb.open('/data/peer.sqlite');
    try {
        await expect(TauriSqlSidecarDb.open('/data/broken.sqlite')).rejects.toBe(failure);
        expect([...pools]).toEqual(['sqlite:/data/peer.sqlite']);
        await expect(peer.getRecordField('/record', 'value')).resolves.toBeUndefined();
    } finally { await peer.close(); }
});

it('preserves both the initialization failure and cleanup failure', async () => {
    const initialization = new Error('schema failed'), cleanup = new Error('close failed');
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_open_database') return false;
        if (command === 'sidecar_close_database') throw cleanup;
        throw initialization;
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    await expect(TauriSqlSidecarDb.open('/data/broken.sqlite')).rejects.toMatchObject({
        errors: [initialization, cleanup], cause: initialization,
    });
});

it('closes an incompatible schema exactly once and scopes the close to its database', async () => {
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_open_database') return false;
        if (command === 'sidecar_close_database') return true;
        if (params.query.includes('sqlite_master')) return [{ name: '_schema_version' }];
        return [{ version: -1 }];
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    await expect(TauriSqlSidecarDb.open('/data/incompatible.sqlite')).rejects.toThrow('version incompatible');
    expect(invoke.mock.calls.filter(call => call[0] === 'sidecar_close_database')).toEqual([
        ['sidecar_close_database', { database: 'sqlite:/data/incompatible.sqlite', scope: 1 }, undefined],
    ]);
});

it('skips DDL on a complete current schema but retains connection setup', async () => {
    const names = ['_schema_version', 'meta_ext', 'meta_tags', 'records', 'idx_meta_tags_tag', 'idx_records_path'];
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_open_database') return false;
        if (params?.query?.includes('sqlite_master')) return names.map(name => ({ name }));
        if (params?.query?.includes('SELECT version')) return [{ version: 4 }];
        return [];
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const db = await TauriSqlSidecarDb.open('/data/current.sqlite');
    try {
        expect(invoke.mock.calls.filter(([command]) => command === 'sidecar_database_execute')).toEqual([]);
        expect(invoke.mock.calls.filter(([command]) => command === 'sidecar_database_select')).toHaveLength(5);
    } finally { await db.close(); }
});

it('repairs a missing schema object instead of trusting only the version stamp', async () => {
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_open_database') return false;
        if (params?.query?.includes('sqlite_master')) return [{ name: '_schema_version' }];
        if (params?.query?.includes('SELECT version')) return [{ version: 4 }];
        return [];
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const db = await TauriSqlSidecarDb.open('/data/partial.sqlite');
    expect(invoke.mock.calls.some(([command, params]) => command === 'sidecar_database_execute' && params.query.includes('CREATE TABLE IF NOT EXISTS records'))).toBe(true);
    await db.close();
});

it('reads each selected sidecar batch with one transaction-scoped select', async () => {
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_open_database') return false;
        if (command === 'sidecar_begin') return 17;
        if (command === 'sidecar_select' && params.query.includes('meta_ext')) {
            return [{ path: '/a', icon: null, device_handler: null, is_asset_dir: 0,
                tags: null, metadata: null, extra: null }];
        }
        if (command === 'sidecar_select') return [
            { field: '__vfs_seq__:a', value: '"one"' },
            { field: '__vfs_seq__:b', value: '"two"' },
        ];
        if (params?.query?.includes('sqlite_master')) return [];
        return [];
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const db = await TauriSqlSidecarDb.open('/data/batch.sqlite');
    try {
        const { metadata, values } = await db.transaction(async tx => ({
            metadata: await tx.getMetaExtMany!(['/a', '/b', '/a']),
            values: await tx.getRecordFields!(
                '/events.seq', ['__vfs_seq__:a', '__vfs_seq__:b', '__vfs_seq__:a'],
            ),
        }));
        expect(metadata.map(row => row.path)).toEqual(['/a']);
        expect(values).toEqual({ '__vfs_seq__:a': 'one', '__vfs_seq__:b': 'two' });
        const selects = invoke.mock.calls.filter(([command]) => command === 'sidecar_select');
        expect(selects).toHaveLength(2);
        expect(selects[0][1]).toMatchObject({ transactionId: 17, database: 'sqlite:/data/batch.sqlite', scope: 1, values: ['/a', '/b'] });
        expect(selects[1][1]).toMatchObject({ transactionId: 17, database: 'sqlite:/data/batch.sqlite', scope: 1,
            values: ['/events.seq', '__vfs_seq__:a', '__vfs_seq__:b'] });
        expect(invoke.mock.calls.find(([command]) => command === 'sidecar_finish')?.[1])
            .toMatchObject({ transactionId: 17, database: 'sqlite:/data/batch.sqlite', scope: 1, commit: true });
    } finally { await db.close(); }
});

it('reads a bounded record page in one select on the transaction connection', async () => {
    const invoke = vi.fn(async (command: string, params: any) => {
        if (command === 'sidecar_open_scope') return 1;
        if (command === 'sidecar_begin') return 42;
        if (command === 'sidecar_select') return [{ total: 1000, field: 'prefix/010', value: '"value"' }];
        if (command === 'sidecar_database_select') return [];
        return true;
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    const db = await TauriSqlSidecarDb.open('/data/page.sqlite');
    try {
        invoke.mockClear();
        const page = await db.transaction(tx => tx.listRecordFieldsPage!('/records', 'prefix/', 10, 1));
        expect(page).toEqual({ total: 1000, rows: [{ field: 'prefix/010', value: 'value' }] });
        expect(invoke.mock.calls.map(call => call[0])).toEqual(['sidecar_begin', 'sidecar_select', 'sidecar_finish']);
        expect(invoke.mock.calls[1][1]).toMatchObject({ transactionId: 42,
            values: ['/records', 'prefix/%', '/records', 'prefix/%', 1, 10] });
        expect(invoke.mock.calls[1][1].query).toContain('LIMIT ? OFFSET ?');
    } finally { await db.close(); }
});

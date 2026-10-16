import { RECORD_PAGE_SQL, recordPageValues, decodeRecordPage, type RecordPageRow } from '@itookit/vfsdriver-local';
import type { ISidecarDb, MetaExtRow } from '@itookit/vfsdriver-local';
import { DDL, SCHEMA_VERSION, PATH_DATA_EXISTS, movePathStatements } from '@itookit/vfsdriver-local';

interface StatementSync {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): unknown;
}

interface DatabaseSync {
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
}

type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

export class NodeSqliteSidecarDb implements ISidecarDb {
    private constructor(private readonly db: DatabaseSync) {}

    static async open(filePath: string): Promise<NodeSqliteSidecarDb> {
        assertNodeVersion();
        const moduleName = 'node:sqlite';
        const sqlite = await import(moduleName) as unknown as { DatabaseSync: DatabaseSyncConstructor };
        const db = new sqlite.DatabaseSync(filePath);
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        if (tables.length) {
            const versions = tables.some(table => table.name === '_schema_version') ? db.prepare('SELECT version FROM _schema_version').all() as Array<{ version: number }> : [];
            if (versions.length !== 1 || versions[0].version !== SCHEMA_VERSION) { db.close(); throw new Error('Filesystem database version incompatible'); }
        }
        db.exec(DDL);
        return new NodeSqliteSidecarDb(db);
    }

    async getMetaExt(itemPath: string): Promise<MetaExtRow | null> {
        const row = this.db.prepare('SELECT * FROM meta_ext WHERE path = ?').get(itemPath);
        return (row as MetaExtRow | undefined) ?? null;
    }

    async upsertMetaExt(row: MetaExtRow): Promise<void> {
        this.db.prepare(`
            INSERT INTO meta_ext (path, icon, device_handler, is_asset_dir, tags, metadata, extra)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                icon=excluded.icon, device_handler=excluded.device_handler,
                is_asset_dir=excluded.is_asset_dir, tags=excluded.tags,
                metadata=excluded.metadata, extra=excluded.extra
        `).run(row.path, row.icon, row.device_handler, row.is_asset_dir, row.tags, row.metadata, row.extra);
    }

    async deleteMetaExt(itemPath: string): Promise<void> {
        this.db.prepare("DELETE FROM meta_ext WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'").run(itemPath, itemPath, itemPath);
    }

    async assertPathDataVacant(itemPath: string): Promise<void> {
        if (this.db.prepare(PATH_DATA_EXISTS).get(itemPath, itemPath, itemPath, itemPath, itemPath, itemPath)) {
            throw new Error(`Destination has durable data: ${itemPath}`);
        }
    }

    async movePathData(from: string, to: string): Promise<void> {
        for (const { sql, values } of movePathStatements(from, to)) this.db.prepare(sql).run(...values);
    }

    async syncTags(itemPath: string, tags: string[] | undefined): Promise<void> {
        this.db.prepare('DELETE FROM meta_tags WHERE path = ?').run(itemPath);
        const insert = this.db.prepare('INSERT OR IGNORE INTO meta_tags (path, tag) VALUES (?, ?)');
        for (const tag of tags ?? []) insert.run(itemPath, tag);
    }

    async getAllDistinctTags(): Promise<string[]> {
        return (this.db.prepare('SELECT DISTINCT tag FROM meta_tags ORDER BY tag').all() as Array<{ tag: string }>)
            .map(row => row.tag);
    }

    async listTagEntries(): Promise<Array<{ path: string; tag: string }>> {
        return this.db.prepare('SELECT path, tag FROM meta_tags ORDER BY path, tag').all() as Array<{ path: string; tag: string }>;
    }

    async queryByTag(tag: string): Promise<string[]> {
        return (this.db.prepare('SELECT path FROM meta_tags WHERE tag = ? ORDER BY path').all(tag) as Array<{ path: string }>)
            .map(row => row.path);
    }

    async getRecordField(itemPath: string, field: string): Promise<unknown | undefined> {
        const row = this.db.prepare('SELECT value FROM records WHERE path = ? AND field = ?')
            .get(itemPath, field) as { value: string } | undefined;
        return row ? JSON.parse(row.value) : undefined;
    }

    /** Requests are pre-batched by the caller (SidecarRecordStore) to stay under the parameter limit. */
    async getRecordFieldsMany(requests: ReadonlyArray<{ path: string; field: string }>): Promise<Array<unknown | undefined>> {
        if (!requests.length) return [];
        const rows = this.db.prepare(
            `SELECT path, field, value FROM records WHERE (path, field) IN (${requests.map(() => '(?, ?)').join(', ')})`)
            .all(...requests.flatMap(request => [request.path, request.field])) as Array<{ path: string; field: string; value: string }>;
        const found = new Map(rows.map(row => [`${row.path}\u0000${row.field}`, JSON.parse(row.value) as unknown]));
        return requests.map(request => found.get(`${request.path}\u0000${request.field}`));
    }

    async setRecordField(itemPath: string, field: string, value: unknown): Promise<void> {
        this.db.prepare(`
            INSERT INTO records(path, field, value) VALUES (?, ?, ?)
            ON CONFLICT(path, field) DO UPDATE SET value = excluded.value
        `).run(itemPath, field, JSON.stringify(value));
    }

    async deleteRecordField(itemPath: string, field: string): Promise<void> {
        this.db.prepare('DELETE FROM records WHERE path = ? AND field = ?').run(itemPath, field);
    }

    async listRecordFields(itemPath: string, prefix = ''): Promise<Array<{ field: string; value: unknown }>> {
        const rows = this.db.prepare(`
            SELECT field, value FROM records
            WHERE path = ? AND field LIKE ? ESCAPE '\\'
            ORDER BY field
        `).all(itemPath, `${escapeLike(prefix)}%`) as Array<{ field: string; value: string }>;
        return rows.map(row => ({ field: row.field, value: JSON.parse(row.value) }));
    }

    async listRecordFieldsPage(path: string, prefix: string, offset: number, limit: number) {
        const rows = this.db.prepare(RECORD_PAGE_SQL).all(...recordPageValues(path, prefix, offset, limit)) as RecordPageRow[];
        return decodeRecordPage(rows);
    }

    async clearRecordFields(itemPath: string): Promise<void> {
        this.db.prepare('DELETE FROM records WHERE path = ?').run(itemPath);
    }

    async begin(): Promise<void> {
        this.db.exec('BEGIN IMMEDIATE');
    }

    async commit(): Promise<void> {
        this.db.exec('COMMIT');
    }

    async rollback(): Promise<void> {
        this.db.exec('ROLLBACK');
    }

    async healthCheck(): Promise<{ ok: boolean; error?: string }> {
        try {
            const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
            const ok = row?.integrity_check === 'ok';
            return ok ? { ok } : { ok, error: row?.integrity_check ?? 'SQLite integrity check failed' };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async close(): Promise<void> {
        this.db.close();
    }
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function assertNodeVersion(): void {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) {
        throw new Error(`MindOS HTTP app requires Node.js >=22.13 for node:sqlite; current ${process.versions.node}`);
    }
}

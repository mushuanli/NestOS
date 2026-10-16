import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** OS-backed SQLite locks survive neither crashes nor process exits. */
export async function acquireHostLock(directory: string): Promise<() => void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const moduleName = 'node:sqlite';
    const { DatabaseSync } = await import(moduleName) as { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } };
    const database = new DatabaseSync(path.join(directory, 'httpd-host-lock.sqlite'));
    try { database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { database.close(); throw new Error('This data or credential directory is already owned by another application host'); }
    return () => database.close();
}

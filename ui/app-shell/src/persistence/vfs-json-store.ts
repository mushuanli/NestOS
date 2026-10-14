/**
 * @file app-shell/persistence/vfs-json-store.ts
 * @desc Serialized JSON documents under `etc:/ui`.
 *
 * Host-owned UI state (browser snapshots, toolbox preferences) shares one
 * inspectable location next to `/ui/theme.json`, so it can be read, backed up and
 * repaired by hand instead of living in the webview's localStorage.
 */
import type { IFileSystem } from '@itookit/vfs-core';

const UI_DIR = '/ui';
/** Document names carry `:` for host namespacing; keep file names stable and shell-safe. */
function fileNameOf(name: string): string { return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`; }

export class VfsJsonStore {
    private tail: Promise<void> = Promise.resolve();
    constructor(private readonly fs: IFileSystem) {}

    /** Parsed document, or `undefined` when it is missing or unreadable. */
    async read(name: string): Promise<unknown | undefined> {
        try {
            const raw = await this.fs.driver.readContent(`${UI_DIR}/${fileNameOf(name)}`);
            const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
            return JSON.parse(text);
        } catch { return undefined; }
    }

    /** Writes are serialized so a burst of changes cannot interleave. */
    write(name: string, value: unknown): void {
        const file = fileNameOf(name), path = `${UI_DIR}/${file}`, content = JSON.stringify(value, null, 2);
        this.tail = this.tail.then(async () => {
            try {
                if (await this.fs.driver.exists(path)) await this.fs.driver.writeContent(path, content);
                else await this.fs.driver.createFile({ name: file, parentPath: UI_DIR, content, recursive: true });
            } catch (error) { console.error('[ui-state] failed to persist', name, error); }
        });
    }

    /** Wait for already-queued writes (shutdown and tests). */
    async flush(): Promise<void> { await this.tail; }
}

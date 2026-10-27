import {constants} from 'node:fs';
import {mkdir, lstat, open, rename, unlink, readdir} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {createModuleLogger} from '@itookit/common';
import type {EditorSwap, EditorSwapStore, EditorSwapSnapshot} from '@itookit/app-contracts/services';
import {canonical, within} from '../runtime/paths';

const log = createModuleLogger('editor-swaps'), maxBytes = 512 * 1024, retentionMs = 48 * 60 * 60 * 1000;
interface SwapRecord extends EditorSwapSnapshot {schemaVersion: 1; owner: string; document: {namespaceId: string; path: string};}
const fail = (code: string, message: string) => Object.assign(new Error(message), {code});
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Host-private optional swap files. No directory is created or scanned while the feature is disabled. */
export class NodeEditorSwapStore implements EditorSwapStore {
    private readonly owner: string;
    private tail: Promise<unknown> = Promise.resolve();
    private timer?: ReturnType<typeof setInterval>;
    private closed = false;
    private constructor(private readonly directory: string, root: string) {this.owner = createHash('sha256').update(root).digest('hex').slice(0, 12);}
    static async start(directory: string, root: string, staticDir: string): Promise<NodeEditorSwapStore> {
        const [target, data, web] = await Promise.all([directory, root, staticDir].map(value => canonical(path.resolve(value))));
        if (within(data, target) || within(web, target)) throw fail('SWAP_DIRECTORY_EXPOSED', 'Swap directory must remain outside data and static roots');
        await mkdir(target, {recursive: true, mode: 0o700});
        const info = await lstat(target);
        if (!info.isDirectory() || process.getuid && info.uid !== process.getuid()) throw fail('SWAP_DIRECTORY_OWNER', 'Swap directory must belong to the host user');
        if (process.platform !== 'win32' && (info.mode & 0o022) !== 0) throw fail('SWAP_DIRECTORY_PERMISSIONS', 'Swap directory must not be writable by other users');
        const store = new NodeEditorSwapStore(target, data); await store.cleanup();
        store.timer = setInterval(() => {void store.cleanup().catch(() => {});}, 60 * 60 * 1000); store.timer.unref();
        return store;
    }
    open(document: {namespaceId: string; path: string}): EditorSwap {
        const file = path.join(this.directory, `.nestos-${this.owner}-${randomUUID()}.swap`);
        return new SwapLease(this, file, document);
    }
    run<T>(stage: string, work: (operationId: string) => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(fail('SWAP_CLOSED', 'Swap service is closed'));
        const operationId = randomUUID(), started = Date.now();
        const next = this.tail.then(() => work(operationId)).then(value => {
            log.info('editor.swap', {operation: 'editor.swap', operationId, stage, result: 'success', durationMs: Date.now() - started}); return value;
        }, error => {
            const code = (error as {code?: unknown})?.code;
            log.warn('editor.swap', {operation: 'editor.swap', operationId, stage, result: 'failure', durationMs: Date.now() - started,
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SWAP_STORAGE_FAILED'}); throw error;
        });
        this.tail = next.catch(() => {}); return next;
    }
    async write(file: string, document: SwapRecord['document'], content: string): Promise<void> {
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') >= maxBytes) throw fail('SWAP_TOO_LARGE', 'Swap files only support content smaller than 512 KiB');
        const record: SwapRecord = {schemaVersion: 1, owner: this.owner, document, content, savedAt: Date.now()};
        const temporary = file + '.tmp-' + randomUUID();
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {await handle.writeFile(JSON.stringify(record)); await handle.sync();} finally {await handle.close();}
            await rename(temporary, file);
        } finally {await unlink(temporary).catch(error => {if (!missing(error)) throw error;});}
    }
    async read(file: string): Promise<EditorSwapSnapshot | undefined> {
        let handle;
        try {handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));}
        catch (error) {if (missing(error)) return; throw error;}
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > maxBytes * 6 + 16384 || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
                throw fail('SWAP_PERMISSIONS', 'Swap file must be a private regular file');
            const value = JSON.parse(await handle.readFile('utf8')) as SwapRecord;
            if (value.schemaVersion !== 1 || value.owner !== this.owner || typeof value.content !== 'string' || !Number.isFinite(value.savedAt)
                || Buffer.byteLength(value.content, 'utf8') >= maxBytes) throw fail('SWAP_INVALID', 'Swap record is invalid');
            return {content: value.content, savedAt: value.savedAt};
        } finally {await handle.close();}
    }
    async remove(file: string): Promise<void> {await unlink(file).catch(error => {if (!missing(error)) throw error;});}
    private cleanup(): Promise<void> {
        return this.run('cleanup', async operationId => {
            const prefix = `.nestos-${this.owner}-`, cutoff = Date.now() - retentionMs; let removed = 0;
            for (const name of await readdir(this.directory)) {
                if (!name.startsWith(prefix) || !/^\.nestos-[a-f0-9]{12}-[a-f0-9-]{36}\.swap(?:\.tmp-[a-f0-9-]{36})?$/.test(name)) continue;
                const file = path.join(this.directory, name);
                try {const info = await lstat(file); if (info.isFile() && info.mtimeMs < cutoff) {await unlink(file); removed++;}}
                catch (error) {if (!missing(error)) throw error;}
            }
            log.info('editor.swap.cleanup', {operation: 'editor.swap.cleanup', operationId, stage: 'expired-files', result: 'success', removed, retentionHours: 48});
        });
    }
    async dispose(): Promise<void> {if (this.timer) clearInterval(this.timer); this.closed = true; await this.tail;}
}
class SwapLease implements EditorSwap {
    private closed = false;
    constructor(private readonly store: NodeEditorSwapStore, private readonly file: string, private readonly document: SwapRecord['document']) {}
    private active(): void {if (this.closed) throw fail('SWAP_CLOSED', 'Editor swap is closed');}
    writeSwap(content: string): Promise<void> {this.active(); return this.store.run('write', () => this.store.write(this.file, this.document, content));}
    readSwap(): Promise<EditorSwapSnapshot | undefined> {this.active(); return this.store.run('read', () => this.store.read(this.file));}
    clearSwap(): Promise<void> {this.active(); return this.store.run('clear', () => this.store.remove(this.file));}
    closeSwap(): Promise<void> {if (this.closed) return Promise.resolve(); this.closed = true; return this.store.run('close', () => this.store.remove(this.file));}
    async dispose(): Promise<void> {this.closed = true; /* Preserve crash/disconnect residue until host expiry cleanup. */}
}

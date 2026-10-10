import { createPiAgentDriver } from '@itookit/piagent-driver';
import { recordRuntimeDiagnostic, runtimeDiagnosticPath, traceRuntimeStage } from './diagnostics';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { CommandOptions } from './commands';
import { createApplicationRuntime, type ApplicationRuntime } from '@itookit/app-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { CliDirectorySourceProvider } from './directories';
import { resolveProfileRoot } from './mindos';
import { NodeSqliteSidecarDb } from './sqlite-sidecar';

const REMOTE_FLAG = `<script>window.__MINDOS_MODE__ = 'remote'; window.__MINDOS_API__ = '/api';</script>`;

const TAURI_SHIM = `<script>
(() => {
  const callbacks = new Map();
  const fileCache = new Map();
  let nextCallback = 0;
  const invoke = async (cmd, args) => {
    const input = args ?? {};
    if (cmd === 'fs_read_file' && typeof input.path === 'string' && fileCache.has(input.path)) return new Uint8Array(fileCache.get(input.path)).buffer;
    const response = await fetch('/__tauri/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args: input }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(cmd + ': ' + (payload?.error ?? response.statusText));
    const result = payload.result;
    if (cmd === 'fs_read_dir' && result && !Array.isArray(result) && Array.isArray(result.entries)) {
      for (const [path, bytes] of Object.entries(result.files ?? {})) fileCache.set(path, bytes);
      return result.entries;
    }
    if (/^(fs_write_file|fs_append_file|fs_remove|fs_rename|fs_mkdir|directory_io)$/.test(cmd)) fileCache.clear();
    if (cmd === 'fs_read_file' || cmd === 'directory_read_file') return result == null ? null : new Uint8Array(result).buffer;
    return result;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke,
    transformCallback: (callback) => { const id = ++nextCallback; callbacks.set(id, callback); return id; },
    unregisterCallback: (id) => { callbacks.delete(id); },
    convertFileSrc: (value) => value,
  };
})();
</script>`;

interface InvokeRequest { cmd: string; args: Record<string, unknown> }
interface DirectoryScope { id: string; root: string }

interface SqliteConnection {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): { changes: number; lastInsertRowid: number | bigint }; all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown };
    close(): void;
}

export interface HttpServerOptions {
    rootDir: string;
    homeDir: string;
    configDir: string;
    staticDir?: string;
    /** Log every HTTP IPC command, duration and resolved error. */
    debug?: boolean;
    /** Already-initialized MindOS runtime exposed by the HTTP host. */
    runtime?: ApplicationRuntime;
}

/** Start the browser-accessible MindOS UI backed by the CLI profile. */
export async function startHttpServer(address: string, options: CommandOptions, runtime?: ApplicationRuntime): Promise<void> {
    const { host, port } = parseHttpAddress(address);
    const rootDir = resolveProfileRoot(options.profile);
    const homeDir = path.resolve(options.setHome ?? process.cwd());
    const configDir = process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'mindos')
        : path.join(process.env.HOME ?? '.', '.config', 'mindos');
    const staticDir = await resolveStaticDir();
    const server = new HttpUiServer({ rootDir, homeDir, configDir, staticDir, debug: Boolean(options.verbose), runtime });
    await new Promise<void>((resolve, reject) => {
        server.http.once('error', reject);
        server.http.listen(port, host, () => resolve());
    });
    const actual = server.http.address();
    const boundPort = typeof actual === 'object' && actual ? actual.port : port;
    process.stdout.write(`MindOS HTTP UI: http://${host}:${boundPort}\n`);
    process.stdout.write(`profile: ${rootDir}\n`);
    process.stdout.write(`workspace: ${homeDir} (${options.setHome ? '--set-home' : 'current working directory'}; UI home)\n`);
    process.stdout.write(`static UI: ${staticDir}\n`);
}

/** Initialize the shared MindOS runtime before the HTTP listener starts. */
export async function createHttpMindOSRuntime(options: CommandOptions, initializeWorkspace = true): Promise<ApplicationRuntime> {
    const rootDir = resolveProfileRoot(options.profile);
    const backend = await openLocalFSBackend({
        rootDir,
        sidecarDir: path.join(rootDir, '_meta'),
        createDb: NodeSqliteSidecarDb.open,
    });
    try {
        return await traceRuntimeStage('http.runtime', () => createApplicationRuntime({
            remoteSourceProvider: createPiAgentDriver(ref => process.env[`MINDOS_REMOTE_${ref.replace(/-/g, '_')}`] ?? ''),
            backend,
            directorySourceProvider: new CliDirectorySourceProvider(rootDir),
            defaultSessionDirectory: initializeWorkspace ? `host:${path.resolve(options.setHome ?? process.cwd())}` : undefined,
            digitalTwinAutoStart: initializeWorkspace,
            ownerKind: 'cli',
            onProgress: stage => recordRuntimeDiagnostic('http.runtime.stage', { stage }),
        }));
    } catch (error) {
        await backend.close();
        throw error;
    }
}

export function parseHttpAddress(value: string): { host: string; port: number } {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('-d requires [ip:]port');
    const index = trimmed.lastIndexOf(':');
    const host = index >= 0 ? trimmed.slice(0, index) : '127.0.0.1';
    const portText = index >= 0 ? trimmed.slice(index + 1) : trimmed;
    const port = Number(portText);
    if (!host || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid -d address: ${value}`);
    return { host, port };
}

async function resolveStaticDir(): Promise<string> {
    const candidates = [
        fileURLToPath(new URL('../../tauri-app/dist', import.meta.url)),
        fileURLToPath(new URL('../../web-app/dist', import.meta.url)),
    ];
    for (const candidate of candidates) {
        try { if ((await stat(candidate)).isDirectory()) return candidate; } catch { /* try next */ }
    }
    throw new Error('No built UI found. Run `pnpm --filter tauri-app build` or `pnpm --filter mind-os build` first.');
}

export class HttpUiServer {
    readonly http = createServer((request, response) => { void this.handle(request, response); });
    private readonly scopes = new Map<string, DirectoryScope>();
    private readonly sqlite = new Map<string, SqliteConnection>();
    private readonly databaseLeases = new Map<string, number>();
    private readonly transactions = new Map<number, { connection: SqliteConnection; scope: number; database: string }>();
    private nextTransaction = 1;
    private sidecarScope = 0;

    constructor(private readonly options: HttpServerOptions) {}

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (url.pathname === '/__tauri/invoke' && request.method === 'POST') return this.invoke(request, response);
            if (url.pathname === '/api/status') return await this.status(response);
            if (url.pathname === '/api/sessions') return await this.sessions(response);
            if (url.pathname === '/api/runs') return await this.runs(response);
            return await this.staticFile(url.pathname, response);
        } catch (error) {
            recordRuntimeDiagnostic('http.request.failed', error);
            return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    }

    private async status(response: ServerResponse): Promise<void> {
        const sessions = this.options.runtime ? await this.options.runtime.sessionRepository.list() : [];
        return json(response, 200, {
            ready: Boolean(this.options.runtime),
            profile: this.options.rootDir,
            workspace: this.options.homeDir,
            sessions: sessions.length,
        });
    }

    private async sessions(response: ServerResponse): Promise<void> {
        const sessions = this.options.runtime ? await this.options.runtime.sessionRepository.list() : [];
        return json(response, 200, sessions.map(session => ({
            id: session.id, title: session.title, origin: session.origin,
            createdAt: session.createdAt, updatedAt: session.updatedAt,
        })));
    }

    private async runs(response: ServerResponse): Promise<void> {
        const runs = this.options.runtime ? await this.options.runtime.runCatalog.list() : [];
        return json(response, 200, runs);
    }

    private async invoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const body = await readJson(request);
        const { cmd, args } = body as InvokeRequest;
        const started = Date.now();
        if (this.options.debug) console.error(`[HTTP] -> ${cmd} ${summarizeArgs(args)}`);
        try {
            const result = await this.command(cmd, args ?? {});
            if (this.options.debug) console.error(`[HTTP] <- ${cmd} ${Date.now() - started}ms`);
            return json(response, 200, { result });
        } catch (error) {
            recordRuntimeDiagnostic('http.invoke.failed', new Error(`IPC ${cmd} failed`, { cause: error }));
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[HTTP] ${cmd} failed after ${Date.now() - started}ms: ${message} ${summarizeArgs(args)}`);
            if (this.options.debug && error instanceof Error && error.stack) console.error(error.stack);
            return json(response, 400, { error: message });
        }
    }

    private async command(cmd: string, args: Record<string, unknown>): Promise<unknown> {
        switch (cmd) {
            case 'diagnostic_log_path': return runtimeDiagnosticPath() ?? null;
            case 'diagnostic_event': recordRuntimeDiagnostic(`frontend.${String(args.event)}`, String(args.message)); return null;
            case 'get_home_dir': return this.options.homeDir;
            case 'get_current_dir': return this.options.homeDir;
            case 'get_root_dir': return this.options.rootDir;
            case 'get_app_data_dir': return this.options.rootDir;
            case 'get_app_config_dir': return this.options.configDir;
            case 'native_capabilities': return { ripgrep: false, fd: false };
            case 'fs_stat': return fsStat(await this.allowedWrite(String(args.path)));
            case 'fs_mkdir': await mkdir(await this.allowedWrite(String(args.path)), { recursive: true }); return null;
            case 'fs_read_file': return [...new Uint8Array(await readFile(await this.allowedExisting(String(args.path))))];
            case 'fs_write_file': await writeAllowedFile(await this.allowedWrite(String(args.path)), Buffer.from(bytes(args.data))); return null;
            case 'fs_append_file': await appendAllowedFile(await this.allowedWrite(String(args.path)), Buffer.from(bytes(args.data))); return null;
            case 'fs_read_dir': return this.readDirectory(await this.allowedExisting(String(args.path)));
            case 'fs_rename': await rename(await this.allowedWrite(String(args.from)), await this.allowedWrite(String(args.to))); return null;
            case 'fs_remove': await rm(await this.allowedWrite(String(args.path)), { recursive: Boolean(args.recursive), force: true }); return null;
            case 'fs_exists': return exists(await this.allowedWrite(String(args.path)));
            case 'directory_open': return this.directoryOpen(String(args.path));
            case 'directory_close': this.scopes.delete(String(args.id)); return null;
            case 'directory_io': return this.directoryIo(args);
            case 'directory_read_file':
                try { return await this.directoryIo({ ...args, operation: 'read' }); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
            case 'plugin:dialog|open':
            case 'plugin:dialog|save': return null;
            case 'plugin:dialog|ask':
            case 'plugin:dialog|confirm': return false;
            case 'plugin:dialog|message': return null;
            case 'plugin:resources|close': return null;
            case 'plugin:sql|load': return this.sqliteLoad(String(args.db));
            case 'plugin:sql|execute': return this.sqliteExecute(String(args.db), String(args.query), values(args.values));
            case 'plugin:sql|select': return this.sqliteSelect(String(args.db), String(args.query), values(args.values));
            case 'plugin:sql|close': return this.sqliteClose(String(args.db));
            case 'sidecar_open_scope': return this.sidecarOpenScope();
            case 'sidecar_open_database': return this.sidecarOpenDatabase(String(args.database), Number(args.scope));
            case 'sidecar_database_execute': return this.sidecarDatabaseExecute(String(args.database), Number(args.scope), String(args.query), values(args.values));
            case 'sidecar_database_select': return this.sidecarDatabaseSelect(String(args.database), Number(args.scope), String(args.query), values(args.values));
            case 'sidecar_close_database': return this.sidecarCloseDatabase(String(args.database), Number(args.scope));
            case 'sidecar_begin': return this.sidecarBegin(String(args.database), Number(args.scope));
            case 'sidecar_execute': return this.sidecarExecute(Number(args.transactionId), String(args.database), Number(args.scope), String(args.query), values(args.values), false);
            case 'sidecar_select': return this.sidecarExecute(Number(args.transactionId), String(args.database), Number(args.scope), String(args.query), values(args.values), true);
            case 'sidecar_finish': return this.sidecarFinish(Number(args.transactionId), String(args.database), Number(args.scope), Boolean(args.commit));
            case 'shell_exec':
            case 'session_shell_exec':
            case 'shell_cancel':
            case 'codex_start':
            case 'codex_send':
            case 'codex_poll':
            case 'codex_stop':
            case 'search_ripgrep':
            case 'search_fd':
                throw new Error(`${cmd} is not available in CLI HTTP mode`);
            default:
                throw new Error(`Unsupported Tauri command: ${cmd}`);
        }
    }

    private async allowedExisting(candidate: string): Promise<string> {
        const resolved = await realpath(path.resolve(candidate));
        this.assertAllowed(resolved, candidate);
        return resolved;
    }

    private async allowedWrite(candidate: string): Promise<string> {
        const resolved = path.resolve(candidate);
        this.assertAllowed(resolved, candidate);
        return resolved;
    }

    private assertAllowed(resolved: string, original: string): void {
        if (!inside(this.options.rootDir, resolved) && !inside(this.options.homeDir, resolved)) {
            throw new Error(`Path is outside the HTTP profile: ${original}`);
        }
    }

    private async directoryOpen(directory: string): Promise<DirectoryScope> {
        const root = await realpath(path.resolve(directory));
        if (!inside(this.options.rootDir, root) && !inside(this.options.homeDir, root)) {
            throw new Error(`Directory is outside the HTTP profile: ${directory}`);
        }
        const id = `http-directory-${randomUUID()}`;
        const scope = { id, root };
        this.scopes.set(id, scope);
        return scope;
    }

    private async directoryIo(args: Record<string, unknown>): Promise<unknown> {
        const scope = this.scopes.get(String(args.id));
        if (!scope) throw new Error('Directory scope is not open');
        const target = resolveScopePath(scope.root, String(args.path ?? ''));
        switch (String(args.operation)) {
            case 'stat': return fsStat(target);
            case 'exists': return exists(target);
            case 'mkdir': await mkdir(target, { recursive: true }); return null;
            case 'list': return fsReadDir(target);
            case 'read': return [...new Uint8Array(await readFile(target))];
            case 'write': await writeFile(target, Buffer.from(bytes(args.data))); return null;
            case 'append': await appendFile(target, Buffer.from(bytes(args.data))); return null;
            case 'rename': await rename(target, resolveScopePath(scope.root, String(args.to ?? ''))); return null;
            case 'unlink': await rm(target, { force: true }); return null;
            case 'rmdir': await rm(target, { recursive: true, force: true }); return null;
            default: throw new Error(`Unsupported directory operation: ${String(args.operation)}`);
        }
    }

    private async sqliteLoad(url: string): Promise<string> {
        const file = sqlitePath(this.options.rootDir, url);
        await mkdir(path.dirname(file), { recursive: true });
        this.sqliteConnection(file);
        return file;
    }

    private sqliteExecute(url: string, query: string, bind: unknown[]): unknown[] {
        const db = this.sqliteConnection(sqlitePath(this.options.rootDir, url));
        const result = db.prepare(query).run(...sanitizeBindings(bind));
        return [Number(result.changes), Number(result.lastInsertRowid)];
    }

    private sqliteSelect(url: string, query: string, bind: unknown[]): unknown[] {
        return this.sqliteConnection(sqlitePath(this.options.rootDir, url)).prepare(query).all(...sanitizeBindings(bind));
    }

    private sqliteClose(url: string): boolean {
        const file = sqlitePath(this.options.rootDir, url);
        this.sqlite.get(file)?.close();
        this.sqlite.delete(file);
        return true;
    }

    private sidecarOpenScope(): number {
        for (const transaction of this.transactions.values()) {
            try { transaction.connection.exec('ROLLBACK'); } catch { /* connection closes below */ }
            transaction.connection.close();
        }
        this.transactions.clear();
        this.databaseLeases.clear();
        return ++this.sidecarScope;
    }

    private async sidecarOpenDatabase(database: string, scope: number): Promise<boolean> {
        this.assertSidecarScope(scope);
        const file = sqlitePath(this.options.rootDir, database);
        const reused = this.sqlite.has(file);
        await this.sqliteLoad(database);
        this.assertSidecarScope(scope);
        this.databaseLeases.set(file, (this.databaseLeases.get(file) ?? 0) + 1);
        return reused;
    }

    private sidecarDatabaseExecute(database: string, scope: number, query: string, bind: unknown[]) {
        const db = this.leasedDatabase(database, scope);
        const result = db.prepare(query).run(...sanitizeBindings(bind));
        return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    }

    private sidecarDatabaseSelect(database: string, scope: number, query: string, bind: unknown[]) {
        return this.leasedDatabase(database, scope).prepare(query).all(...sanitizeBindings(bind));
    }

    private sidecarCloseDatabase(database: string, scope: number): boolean {
        if (scope !== this.sidecarScope) return false;
        const file = sqlitePath(this.options.rootDir, database), count = this.databaseLeases.get(file);
        if (!count) return false;
        if (count > 1) { this.databaseLeases.set(file, count - 1); return false; }
        for (const [id, transaction] of this.transactions) {
            if (transaction.scope !== scope || transaction.database !== file) continue;
            transaction.connection.exec('ROLLBACK');
            transaction.connection.close();
            this.transactions.delete(id);
        }
        this.databaseLeases.delete(file);
        return this.sqliteClose(database);
    }

    private async sidecarBegin(database: string, scope: number): Promise<number> {
        this.leasedDatabase(database, scope);
        const file = sqlitePath(this.options.rootDir, database);
        if (this.options.debug) console.error(`[HTTP] sidecar_begin database=${database} file=${file}`);
        await mkdir(path.dirname(file), { recursive: true });
        this.leasedDatabase(database, scope);
        const sqlite = loadSqlite();
        const connection = new sqlite.DatabaseSync(file) as SqliteConnection;
        connection.exec('PRAGMA journal_mode = WAL');
        connection.exec('PRAGMA busy_timeout = 30000');
        connection.exec('PRAGMA foreign_keys = ON');
        connection.exec('BEGIN IMMEDIATE');
        const id = this.nextTransaction++;
        this.transactions.set(id, { connection, scope, database: file });
        return id;
    }

    private sidecarExecute(transactionId: number, database: string, scope: number, query: string, bind: unknown[], select: boolean): unknown {
        const transaction = this.transactions.get(transactionId);
        if (!transaction || transaction.scope !== scope || scope !== this.sidecarScope
            || transaction.database !== sqlitePath(this.options.rootDir, database)) throw new Error('Sidecar transaction is not open');
        return select ? transaction.connection.prepare(query).all(...sanitizeBindings(bind)) : transaction.connection.prepare(query).run(...sanitizeBindings(bind));
    }

    private sidecarFinish(transactionId: number, database: string, scope: number, commit: boolean): null {
        const transaction = this.transactions.get(transactionId);
        if (!transaction || transaction.scope !== scope || scope !== this.sidecarScope
            || transaction.database !== sqlitePath(this.options.rootDir, database)) throw new Error('Sidecar transaction is not open');
        transaction.connection.exec(commit ? 'COMMIT' : 'ROLLBACK');
        transaction.connection.close();
        this.transactions.delete(transactionId);
        return null;
    }

    private leasedDatabase(database: string, scope: number): SqliteConnection {
        this.assertSidecarScope(scope);
        const file = sqlitePath(this.options.rootDir, database);
        if (!this.databaseLeases.has(file)) throw new Error('Sidecar database is not leased by this page');
        return this.sqliteConnection(file);
    }

    private assertSidecarScope(scope: number): void {
        if (scope !== this.sidecarScope) throw new Error('Sidecar page scope is no longer active');
    }

    private sqliteConnection(file: string): SqliteConnection {
        let connection = this.sqlite.get(file);
        if (!connection) {
            const sqlite = loadSqlite();
            connection = new sqlite.DatabaseSync(file) as SqliteConnection;
            connection.exec('PRAGMA journal_mode = WAL');
            connection.exec('PRAGMA busy_timeout = 30000');
            connection.exec('PRAGMA foreign_keys = ON');
            this.sqlite.set(file, connection);
        }
        return connection;
    }

    private async readDirectory(directory: string): Promise<unknown> {
        const entries = await fsReadDir(directory);
        if (!this.shouldPrefetch(directory, entries.length)) return entries;
        const files: Record<string, number[]> = {};
        let bytesRead = 0;
        for (const entry of entries) {
            if (entry.is_directory) continue;
            const file = path.join(directory, entry.name);
            try {
                const info = await stat(file);
                if (info.size > 2_000_000 || bytesRead + info.size > 2_000_000) break;
                files[file] = [...new Uint8Array(await readFile(file))];
                bytesRead += info.size;
            } catch { /* skip unreadable entry */ }
        }
        return Object.keys(files).length ? { entries, files } : entries;
    }

    private shouldPrefetch(directory: string, count: number): boolean {
        return count <= 64 && (directory.includes(`${path.sep}llm${path.sep}`) || directory.includes(`${path.sep}etc${path.sep}`));
    }

    private async staticFile(pathname: string, response: ServerResponse): Promise<void> {
        const safe = pathname === '/' ? '/index.html' : pathname;
        const file = path.resolve(this.options.staticDir ?? '', '.' + safe);
        if (!inside(this.options.staticDir ?? '', file)) return json(response, 403, { error: 'Forbidden' });
        try {
            const content = await readFile(file);
            if (file.endsWith('.html')) return html(response, injectShim(content.toString('utf8')));
            response.writeHead(200, { 'content-type': contentType(file) });
            response.end(content);
        } catch {
            try {
                const index = await readFile(path.join(this.options.staticDir ?? '', 'index.html'), 'utf8');
                return html(response, injectShim(index));
            } catch {
                return json(response, 404, { error: 'UI build not found' });
            }
        }
    }
}

function injectShim(html: string): string {
    return html.includes('</head>') ? html.replace('</head>', `${REMOTE_FLAG}${TAURI_SHIM}</head>`) : `${REMOTE_FLAG}${TAURI_SHIM}${html}`;
}

function sqlitePath(rootDir: string, url: string): string {
    const value = url.startsWith('sqlite:') ? url.slice('sqlite:'.length) : url;
    return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

const require = createRequire(import.meta.url);

function loadSqlite(): { DatabaseSync: new (file: string) => unknown } {
    // node:sqlite is stable in the Node version required by apps/cli/package.json.
    return require('node:sqlite') as { DatabaseSync: new (file: string) => unknown };
}

function resolveScopePath(root: string, relative: string): string {
    const target = path.resolve(root, relative.replace(/^\/+/, ''));
    if (!inside(root, target)) throw new Error('Directory scope traversal denied');
    return target;
}

async function writeAllowedFile(file: string, data: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
}

async function appendAllowedFile(file: string, data: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, data);
}

async function fsStat(file: string): Promise<unknown> {
    try {
        const info = await stat(file);
        return { size: info.size, mtime_ms: info.mtimeMs, birthtime_ms: info.birthtimeMs, is_directory: info.isDirectory() };
    } catch { return null; }
}

async function fsReadDir(directory: string): Promise<Array<{ name: string; is_directory: boolean }>> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map(entry => ({ name: entry.name, is_directory: entry.isDirectory() }));
}

async function exists(file: string): Promise<boolean> { try { await stat(file); return true; } catch { return false; } }

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
    if (!args) return '';
    const parts: string[] = [];
    for (const key of ['path', 'from', 'to', 'db', 'database', 'operation', 'id', 'transactionId', 'query']) {
        const value = args[key];
        if (value === undefined) continue;
        const text = String(value);
        parts.push(`${key}=${text.length > 160 ? `${text.slice(0, 160)}...` : text}`);
    }
    if (Array.isArray(args.data)) parts.push(`data=${args.data.length} bytes`);
    if (Array.isArray(args.values)) parts.push(`values=${args.values.length}`);
    return parts.join(' ');
}

function bytes(value: unknown): Uint8Array { return Uint8Array.from(Array.isArray(value) ? value as number[] : []); }
function values(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function sanitizeBindings(value: unknown[]): unknown[] {
    return value.map(item => {
        if (item === undefined) return null;
        if (typeof item === 'boolean') return item ? 1 : 0;
        if (item instanceof Date) return item.toISOString();
        if (typeof item === 'object' && item !== null && !(item instanceof Uint8Array) && !(item instanceof ArrayBuffer)) return JSON.stringify(item);
        return item;
    });
}

function readJson(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
        request.on('error', reject);
    });
}

function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string): void {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
}

function contentType(file: string): string {
    const extension = path.extname(file).toLowerCase();
    return ({
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
    })[extension] ?? 'application/octet-stream';
}

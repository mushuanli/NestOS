import {z} from 'zod/v4';
import {mkdir, lstat, readFile, writeFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createModuleLogger} from '@itookit/common';
import type {ToolRunRecord} from '@itookit/app-contracts/services';
import type {Tool} from '@itookit/tools';
const text = z.string().max(200);
const collection = z.object({version: z.literal(1), complete: z.boolean(), processed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), batchCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()});
const record = z.object({id: text, packageKey: text, toolId: text, version: text, startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(), durationMs: z.number().nonnegative().optional(), status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']), code: text.optional(), sessionId: text.optional(), taskId: text.optional(), operationId: text.optional(), collection: collection.optional()});
const log = createModuleLogger('tool-history');

/** Bounded user-private execution metadata, never arguments, result bodies or exception text. */
export class ToolHistory {
    private rows: Array<ToolRunRecord & {packageKey: string}> = [];
    private tail = Promise.resolve();
    constructor(private readonly file: string) {}
    async initialize(): Promise<void> {
        try {
            const info = await lstat(this.file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('TOOL_HISTORY_NOT_PRIVATE');
            let data: unknown;
            try {data = JSON.parse(await readFile(this.file, 'utf8'));} catch {throw new Error('TOOL_HISTORY_INVALID');}
            const parsed = z.array(record).max(500).safeParse(data);
            if (!parsed.success) throw new Error('TOOL_HISTORY_INVALID');
            this.rows = parsed.data.map(row => ({...row, ...(row.status === 'running' ? {status: 'unknown'} : {})}));
        } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    list(packageKey: string): ToolRunRecord[] {
        return this.rows.filter(row => row.packageKey === packageKey).slice(-20).reverse().map(({packageKey: _key, ...row}) => ({...row}));
    }
    busy(packageKey: string): boolean {return this.rows.some(row => row.packageKey === packageKey && row.status === 'running');}
    async call(tool: Tool, packageKey: string, args: Parameters<Tool['call']>[0], context: Parameters<Tool['call']>[1]) {
        const identity = context.executionIdentity;
        const row = {id: randomUUID(), packageKey, toolId: tool.name, version: tool.version ?? '1', startedAt: Date.now(), status: 'running' as ToolRunRecord['status'],
            collection: undefined as ToolRunRecord['collection'],
            ...(identity ? {operationId: identity.operationId, sessionId: identity.sessionId, taskId: identity.taskId} : {})};
        this.rows.push(row);
        try {await this.persist();} catch {row.status = 'unknown'; log.warn('tool.history.persist', {operationId: row.id, stage: 'start', result: 'failure', code: 'TOOL_HISTORY_WRITE_FAILED'}); throw new Error('TOOL_HISTORY_WRITE_FAILED');}
        try {const result = await tool.call(args, context); row.status = 'succeeded';
            const summary = collection.safeParse((result.data as {collection?: unknown} | null)?.collection);
            if (summary.success) row.collection = summary.data;
            return result;}
        catch (error) {
            row.status = context.signal?.aborted ? 'cancelled' : 'failed';
            const code = (error as {code?: string})?.code;
            Object.assign(row, {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'TOOL_EXECUTION_FAILED'}); throw error;
        } finally {
            Object.assign(row, {finishedAt: Date.now(), durationMs: Date.now() - row.startedAt});
            await this.persist().catch(() => log.warn('tool.history.persist', {operationId: row.id, stage: 'finish', result: 'failure', code: 'TOOL_HISTORY_WRITE_FAILED'}));
        }
    }
    async close(): Promise<void> {await this.tail;}
    private persist(): Promise<void> {
        const work = this.tail.then(async () => {
            this.rows = this.rows.filter(row => row.status === 'running').concat(this.rows.filter(row => row.status !== 'running').slice(-450)).sort((a, b) => a.startedAt - b.startedAt);
            const temporary = this.file + '.' + randomUUID() + '.tmp';
            await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
            try {await writeFile(temporary, JSON.stringify(this.rows), {mode: 0o600, flag: 'wx'}); await rename(temporary, this.file);}
            finally {await rm(temporary, {force: true});}
        }); this.tail = work.catch(() => {}); return work;
    }
}

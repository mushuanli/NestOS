import {mkdir, lstat, readFile, open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {ToolConnectionAccess, ToolConnectionInput, ToolConnectionType} from '@itookit/app-contracts/services';

const failure = (code: string) => Object.assign(new Error(code), {code});
/** Created per runtime from its private auth directory; caller input never selects a user or path. */
export class NodeToolConnections implements ToolConnectionAccess {
    private readonly types = new Map<string, ToolConnectionType>();
    private tail = Promise.resolve();
    constructor(private readonly directory: string) {}
    register(type: ToolConnectionType): void {
        if (!/^[a-z][a-z0-9.-]{0,79}$/.test(type.id) || !type.fields.length
            || new Set(type.fields.map(field => field.name)).size !== type.fields.length
            || type.fields.some(field => !/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(field.name))) throw failure('TOOL_CONNECTION_TYPE_INVALID');
        this.types.set(type.id, structuredClone(type));
    }
    async snapshot() {
        const records = await this.read();
        return {types: [...this.types.values()].map(type => structuredClone(type)), connections: records.map(record => {
            const fields = this.types.get(record.type)?.fields ?? [];
            return {id: record.id, type: record.type, name: record.name,
                values: Object.fromEntries(fields.filter(field => !field.secret).map(field => [field.name, record.values[field.name] ?? ''])),
                configuredSecrets: fields.filter(field => field.secret && record.values[field.name]).map(field => field.name)};
        })};
    }
    async resolve(id: string, type: string): Promise<Record<string, string>> {
        const record = (await this.read()).find(item => item.id === id && item.type === type);
        if (!record || !this.types.has(type)) throw failure('TOOL_CONNECTION_NOT_FOUND');
        return {...record.values};
    }
    save(input: ToolConnectionInput): Promise<void> {
        return this.mutate('save', records => {
            const type = this.types.get(input?.type);
            if (!type || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.id) || !input.name?.trim()
                || input.name.length > 200 || !input.values || typeof input.values !== 'object') throw failure('TOOL_CONNECTION_INVALID');
            const previous = records.find(record => record.id === input.id);
            if (previous && previous.type !== input.type) throw failure('TOOL_CONNECTION_TYPE_CONFLICT');
            if (Object.keys(input.values).some(key => !type.fields.some(field => field.name === key))) throw failure('TOOL_CONNECTION_FIELD_INVALID');
            const values: Record<string, string> = {};
            for (const field of type.fields) {
                const value = input.values[field.name];
                if (value !== undefined && (typeof value !== 'string' || value.length > 16384)) throw failure('TOOL_CONNECTION_FIELD_INVALID');
                values[field.name] = field.secret && !value ? previous?.values[field.name] ?? '' : value?.trim() ?? '';
                if (field.required && !values[field.name]) throw failure('TOOL_CONNECTION_REQUIRED_FIELD');
            }
            return [...records.filter(record => record.id !== input.id), {id: input.id, type: input.type, name: input.name.trim(), values}];
        });
    }
    remove(id: string): Promise<void> {return this.mutate('remove', records => records.filter(record => record.id !== id));}
    private async read(): Promise<ToolConnectionInput[]> {
        await mkdir(this.directory, {recursive: true, mode: 0o700}); await this.checkPrivate(this.directory, true);
        const file = path.join(this.directory, 'connections.json');
        try {
            await this.checkPrivate(file);
            const records: unknown = JSON.parse(await readFile(file, 'utf8'));
            if (!Array.isArray(records) || records.some(record => !record || typeof record.id !== 'string'
                || typeof record.type !== 'string' || typeof record.name !== 'string' || !record.values || typeof record.values !== 'object' || Array.isArray(record.values)
                || Object.values(record.values).some(value => typeof value !== 'string'))) throw failure('TOOL_CONNECTION_STORAGE_INVALID');
            return records;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            if (error instanceof SyntaxError) throw failure('TOOL_CONNECTION_STORAGE_INVALID');
            if (/^TOOL_CONNECTION_[A-Z_]+$/.test((error as NodeJS.ErrnoException).code ?? '')) throw error;
            throw failure((error as NodeJS.ErrnoException).code === 'EACCES' ? 'TOOL_CONNECTION_STORAGE_DENIED' : 'TOOL_CONNECTION_STORAGE_FAILED');
        }
    }
    private async checkPrivate(file: string, directory = false): Promise<void> {
        const info = await lstat(file);
        if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
            || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw failure('TOOL_CONNECTION_STORAGE_NOT_PRIVATE');
    }
    private mutate(action: string, change: (records: ToolConnectionInput[]) => ToolConnectionInput[]): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        const operation = this.tail.then(async () => {
            const records = change(await this.read()), temporary = path.join(this.directory, randomUUID() + '.tmp');
            try {
                const handle = await open(temporary, 'wx', 0o600);
                try {await handle.writeFile(JSON.stringify(records)); await handle.sync();} finally {await handle.close();}
                await rename(temporary, path.join(this.directory, 'connections.json'));
                const handleDirectory = await open(this.directory, 'r');
                try {await handleDirectory.sync();} finally {await handleDirectory.close();}
            } finally {await unlink(temporary).catch(() => {});}
        });
        const observed = operation.then(() => {console.info('[ToolConnections]', {operation: action, operationId, stage: 'persist', result: 'success', durationMs: Date.now() - started});}, error => {
            console.warn('[ToolConnections]', {operation: action, operationId, stage: 'persist', result: 'failure', code: /^TOOL_CONNECTION_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'TOOL_CONNECTION_STORAGE_FAILED', durationMs: Date.now() - started});
            throw error;
        });
        this.tail = observed.catch(() => {}); return observed;
    }
}

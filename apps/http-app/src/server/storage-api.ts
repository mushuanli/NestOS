import { FSError, type IStorageBackend, type IRecordStore } from '@itookit/vfs-core';
import { MAX_BATCH, type Commit } from '../protocol';
import { commitRecords, readMany, readPage, validateRequests } from './record-api';
import { PathGuard } from './path-guard';

type Method = (...args: any[]) => Promise<unknown>;

export class StorageApi {
    private readonly guard: PathGuard;
    private readonly methods: Record<string, Method>;
    constructor(private readonly backend: IStorageBackend, root: string) {
        this.guard = new PathGuard(root);
        this.methods = this.createMethods();
    }
    async invoke(method: unknown, args: unknown): Promise<unknown> {
        if (typeof method !== 'string' || !Object.hasOwn(this.methods, method) || !Array.isArray(args)) throw new FSError('EINVAL', 'Unknown VFS method');
        return this.methods[method](...args);
    }
    private createMethods(): Record<string, Method> {
        const backend = this.backend, records = backend.records!;
        const pathMethod = (method: Method): Method => async (path, ...args) => method(await this.guard.check(path), ...args);
        return {
            init: async () => ({ records: Boolean(records?.transaction) }),
            stat: pathMethod(backend.stat.bind(backend)),
            statType: pathMethod(backend.statType!.bind(backend)),
            statTypes: async paths => {
                if (!Array.isArray(paths) || paths.length > 1000) throw new FSError('EINVAL', 'Invalid type probe batch');
                const checked = await Promise.all(paths.map(value => this.guard.check(value)));
                return Promise.all(checked.map(value => backend.statType!(value)));
            },
            list: pathMethod(async path => (await backend.list(path)).filter(node => this.guard.visible(node.path))),
            listEntries: pathMethod(async path => (await backend.listEntries!(path)).filter(node => this.guard.visible(node.path))),
            mkdir: pathMethod(backend.mkdir.bind(backend)),
            delete: pathMethod(async (path, options) => { this.nonRoot(path); await backend.delete(path, options); }),
            rename: pathMethod(async (from, to) => { this.nonRoot(from); this.nonRoot(to); await backend.rename(from, await this.guard.check(to)); }),
            read: pathMethod(async (path, options) => Buffer.from(await backend.read(path, readOptions(options))).toString('base64')),
            write: pathMethod(async (path, data) => { this.nonRoot(path); return backend.write(path, decode(data)); }),
            updateMetadata: pathMethod(backend.updateMetadata.bind(backend)),
            setTags: pathMethod(backend.setTags.bind(backend)),
            getAllTags: backend.getAllTags.bind(backend),
            listTagEntries: backend.listTagEntries!.bind(backend),
            'records.getMany': async requests => readMany(records, await validateRequests(this.guard, requests)),
            'records.walk': pathMethod((path, options) => readPage(records, path, options)),
            'records.commit': (input: Commit) => commitRecords(records, this.guard, input),
            ...this.recordMethods(records, pathMethod),
        };
    }
    private recordMethods(records: IRecordStore, wrap: (method: Method) => Method): Record<string, Method> {
        return Object.fromEntries(['setRecordField', 'deleteRecordField', 'setAllRecordFields', 'clearRecordFields',
            'createRecordIndex', 'deleteRecordIndex', 'queryRecordFields'].map(name => {
            const method = records[name as keyof IRecordStore] as Method;
            return [`records.${name}`, wrap(method.bind(records))];
        }));
    }
    private nonRoot(path: unknown): void { if (path === '/') throw new FSError('EACCES', 'Cannot mutate the data root'); }
}

function decode(value: unknown): Uint8Array {
    if (typeof value !== 'string' || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new FSError('EINVAL', 'Invalid base64 file content');
    }
    // Copy to an exact-length ArrayBuffer for the LocalFS write contract.
    return Uint8Array.from(Buffer.from(value, 'base64'));
}

function readOptions(value: any): { offset?: number; length?: number } | undefined {
    if (!value) return undefined;
    for (const key of ['offset', 'length']) {
        if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new FSError('EINVAL', 'Invalid file range');
    }
    if (value.length > MAX_BATCH * 1024) throw new FSError('EFBIG', 'File range is too large');
    return { offset: value.offset, length: value.length };
}

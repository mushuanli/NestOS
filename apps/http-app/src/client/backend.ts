import type { IStorageBackend, FSNode, DirEntry, OperationOptions, ReadOptions } from '@itookit/vfs-core';
import { HttpRecordStore } from './records';
import { HttpTransport } from './transport';

export class HttpStorageBackend implements IStorageBackend {
    readonly name = 'http-localfs';
    readonly records: HttpRecordStore;
    constructor(private readonly transport = new HttpTransport()) { this.records = new HttpRecordStore(transport); }
    async init(): Promise<void> { await this.transport.call('init'); }
    async close(): Promise<void> { /* The server owns the shared backend lifetime. */ }
    stat(path: string, options?: OperationOptions): Promise<FSNode | null> {
        return this.transport.call('stat', [path], options?.signal);
    }
    statType(path: string, options?: OperationOptions): Promise<Pick<FSNode, 'type'> | null> {
        return this.transport.call('statType', [path], options?.signal);
    }
    list(path: string, options?: OperationOptions): Promise<FSNode[]> {
        return this.transport.call('list', [path], options?.signal);
    }
    listEntries(path: string, options?: OperationOptions): Promise<DirEntry[]> {
        return this.transport.call('listEntries', [path], options?.signal);
    }
    mkdir(path: string, options?: OperationOptions): Promise<FSNode> {
        return this.transport.call('mkdir', [path], options?.signal);
    }
    delete(path: string, options?: OperationOptions & { recursive?: boolean }): Promise<void> {
        return this.transport.call('delete', [path, { recursive: options?.recursive }], options?.signal);
    }
    rename(from: string, to: string, options?: OperationOptions): Promise<void> {
        return this.transport.call('rename', [from, to], options?.signal);
    }
    async read(path: string, options?: ReadOptions): Promise<Uint8Array> {
        const base64 = await this.transport.call<string>('read', [path, { offset: options?.offset, length: options?.length }], options?.signal);
        return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    }
    write(path: string, bytes: Uint8Array): Promise<FSNode> { return this.transport.call('write', [path, encode(bytes)]); }
    updateMetadata(path: string, metadata: Record<string, unknown>): Promise<void> {
        return this.transport.call('updateMetadata', [path, metadata]);
    }
    setTags(path: string, tags: string[]): Promise<void> { return this.transport.call('setTags', [path, tags]); }
    getAllTags(): Promise<string[]> { return this.transport.call('getAllTags'); }
    listTagEntries(): Promise<Array<{ path: string; tag: string }>> { return this.transport.call('listTagEntries'); }
}

function encode(bytes: Uint8Array): string {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
}

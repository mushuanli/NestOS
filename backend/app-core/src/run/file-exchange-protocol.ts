import {sha256HexSync} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import {failure, publishImmutableFile, readPrompt} from './prompt-bundle';
import {parseSessionFile} from './session-file-result';
export interface FileReply {path: string; sha256: string}
export interface FileRequest {schema: 'work-message/2'; id: string; type: 'request'; scopeId: string; method: string; waitForResponse: true; params: Record<string, unknown>}
export interface FileResponse {schema: 'work-message/2'; id: string; type: 'response'; scopeId: string; replyTo: string; requestDigest: string; status: 'ok' | 'error'; payload?: unknown; error?: {code: string}}
export const fileRequestDigest = (value: FileRequest): string => sha256HexSync(JSON.stringify(canonical(value)));
function canonical(value: unknown): unknown {
    if (typeof value === 'number' && !Number.isFinite(value)) throw failure('FILE_EXCHANGE_SCOPE_INVALID');
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return value;
}
export async function initializeFileExchange(fs: IFileSystem, directory: string, scopeId: string, methods: Array<{name: string; params: Record<string, unknown>}> = []): Promise<void> {
    for (const name of ['inbox', 'outbox']) {
        try {await fs.driver.createDirectory({parentPath: directory, name, recursive: true});}
        catch (error) {if ((error as {code?: string})?.code !== 'EEXIST') throw error;}
    }
    await publishImmutableFile(fs, directory, 'exchange.json', JSON.stringify({schema: 'work-message/2', scopeId,
        methods, request: {schema: 'work-message/2', id: '<unique-id>', type: 'request', scopeId, method: methods[0]?.name ?? '<declared-method>', waitForResponse: true,
            params: methods[0]?.params ?? {}},
        publication: 'Atomically publish immutable inbox/<id>.yaml. Then end this turn WITHOUT a result or lifecycle completion. The host will write outbox/<id>.yaml and resume this SAME Session. Never wait in a polling loop or write outbox files.', maxBytes: 65536}));
}
export async function readFileRequests(fs: IFileSystem, directory: string, scopeId: string): Promise<FileRequest[]> {
    const files = await fs.driver.getChildren(directory + '/inbox', {fields: 'entry'});
    if (files.length > 200) throw failure('FILE_EXCHANGE_LIMIT');
    const requests: FileRequest[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (file.type !== 'file' || !/^[\w-]{1,128}\.(yaml|yml|json)$/.test(file.name)) continue;
        const value = parseSessionFile(await readPrompt(fs, directory + '/inbox/' + file.name)) as FileRequest;
        if (value?.schema !== 'work-message/2') continue;
        if (value.type !== 'request' || value.scopeId !== scopeId || value.id !== file.name.slice(0, file.name.lastIndexOf('.'))
            || value.waitForResponse !== true || typeof value.method !== 'string' || !/^[a-z][a-z0-9.-]{1,95}$/.test(value.method)
            || !value.params || typeof value.params !== 'object' || Array.isArray(value.params)) throw failure('FILE_EXCHANGE_SCOPE_INVALID');
        requests.push(value);
    }
    return requests;
}
export function responseText(response: FileResponse): string {
    const text = JSON.stringify(response);
    if (new TextEncoder().encode(text).byteLength > 65536) throw failure('FILE_EXCHANGE_RESPONSE_LIMIT');
    return text;
}

import type {IFileSystem, FSFileNode} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {parseMail, parseMailSource, type MailMessage, type MailSource} from './model';
const log = createModuleLogger('mail');
export interface MailSnapshot {messages: MailMessage[]; sources: MailSource[]; warnings: string[]}
interface CacheEntry {stamp: string; message: MailMessage}
export class MailArchive {
    private readonly cache = new Map<string, CacheEntry>();
    constructor(readonly files: IFileSystem) {}
    async read(signal: AbortSignal): Promise<MailSnapshot> {
        const operationId = randomUUID(), started = Date.now(), snapshot: MailSnapshot = {messages: [], sources: [], warnings: []};
        try {
            const entries = await this.entries(signal), declared = new Map<string, MailSource>();
            for (const node of entries.filter(node => node.name === '.mail-source.json')) {
                try {const source = parseMailSource(await this.text(node, signal, 8192), parent(node.path)); declared.set(source.id, source);}
                catch (error) {snapshot.warnings.push(safeCode(error));}
            }
            let bytes = 0;
            const messages = entries.filter(node => node.name.endsWith('.email'));
            if (messages.reduce((size, node) => size + (node.size ?? 0), 0) > 32 * 1024 * 1024) throw new Error('MAIL_TOTAL_SIZE_LIMIT');
            for (let offset = 0; offset < messages.length; offset += 8) await Promise.all(messages.slice(offset, offset + 8).map(async node => {
                try {
                    const source = nearest(declared, node.path); if (!declared.has(source.id)) declared.set(source.id, source);
                    const message = await this.message(node, source.id, signal); bytes += message.size;
                    if (bytes > 32 * 1024 * 1024) throw new Error('MAIL_TOTAL_SIZE_LIMIT');
                    snapshot.messages.push(message);
                } catch (error) {if (signal.aborted || safeCode(error) === 'MAIL_TOTAL_SIZE_LIMIT') throw error; snapshot.warnings.push(safeCode(error));}
            }));
            snapshot.sources = [...declared.values()];
            const paths = new Set(messages.map(node => node.path)); for (const key of this.cache.keys()) if (!paths.has(key)) this.cache.delete(key);
            log.info('mail.read', {operationId, stage: 'complete', result: snapshot.warnings.length ? 'partial' : 'success', count: snapshot.messages.length, sourceCount: snapshot.sources.length, bytes, warningCount: snapshot.warnings.length, durationMs: Date.now() - started});
            return snapshot;
        } catch (error) {
            log.warn('mail.read', {operationId, stage: 'archive.read', result: 'failure', code: safeCode(error), durationMs: Date.now() - started});
            throw new Error(safeCode(error));
        }
    }
    async document(path: string, signal: AbortSignal) {
        const node = await this.files.driver.getNode(path, {signal});
        if (!node || node.type !== 'file' || !path.endsWith('.email')) throw new Error('MAIL_MESSAGE_UNAVAILABLE');
        return parseMail(await this.text(node, signal), node.name);
    }
    private async message(node: FSFileNode, sourceId: string, signal: AbortSignal): Promise<MailMessage> {
        const stamp = JSON.stringify([node.version, node.modifiedAt, node.size]), cached = this.cache.get(node.path);
        if (cached?.stamp === stamp) return {...cached.message, sourceId};
        const content = await this.text(node, signal), document = parseMail(content, node.name);
        const message: MailMessage = {id: node.path, sourceId, subject: document.subject, from: document.from, to: document.to,
            date: document.date, modified: Number(node.modifiedAt) || 0, size: new TextEncoder().encode(content).byteLength, version: String(node.version)};
        this.cache.set(node.path, {stamp, message}); return message;
    }
    private async entries(signal: AbortSignal): Promise<FSFileNode[]> {
        const queue = ['/'], files: FSFileNode[] = []; let visited = 0;
        while (queue.length) for (const node of await this.files.driver.getChildren(queue.shift()!, {includeHidden: true, signal})) {
            signal.throwIfAborted(); if (++visited > 20000) throw new Error('MAIL_FILE_COUNT_LIMIT');
            if (node.name.startsWith('.') && node.name !== '.mail-source.json') continue;
            if (node.type === 'directory') queue.push(node.path);
            else if (node.type === 'file' && (node.name === '.mail-source.json' || node.name.endsWith('.email'))) files.push(node);
        }
        return files;
    }
    private async text(node: FSFileNode, signal: AbortSignal, limit = 512 * 1024): Promise<string> {
        if ((node.size ?? 0) > limit) throw new Error('MAIL_FILE_TOO_LARGE');
        const content = await this.files.driver.readContent(node.path, {encoding: 'utf-8', signal});
        if (new TextEncoder().encode(content).byteLength > limit) throw new Error('MAIL_FILE_TOO_LARGE');
        return content;
    }
}
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
function nearest(sources: Map<string, MailSource>, path: string): MailSource {
    let directory = parent(path);
    while (true) {
        const source = sources.get(directory); if (source) return source;
        if (directory === '/') break; directory = parent(directory);
    }
    const id = parent(path), segments = id.split('/').filter(Boolean);
    return {id, providerId: segments[0] || 'local', provider: segments[0] || 'Local', accountId: id, account: segments.slice(1).join(' / ') || 'Local', name: ''};
}
export function safeCode(error: unknown): string {
    const code = (error as {code?: string})?.code ?? (error instanceof Error ? error.message : '');
    return /^(MAIL_[A-Z_]+|ENOENT|EACCES|EIO|ENETUNREACH)$/.test(code) ? code : error instanceof SyntaxError ? 'MAIL_SOURCE_INVALID' : 'MAIL_READ_FAILED';
}

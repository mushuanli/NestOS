import {parseSessionFile} from './session-file-result';
import {sha256HexSync} from '@itookit/common';
import {FSError, type IFileSystem} from '@itookit/vfs-core';

export interface WorkspaceMessageScope {runId: string; itemId: string; attemptId: string}
export interface WorkspaceMessage extends WorkspaceMessageScope {
    schema: 'work-message/1'; id: string; type: 'progress' | 'clarification' | 'error' | 'result'; content: string; replyTo?: string;
}
interface Journal {get<T>(key: string): Promise<T | undefined>; update<T>(key: string, change: (old: T | undefined) => T): Promise<T>}
interface Receipt {digest: string; message: WorkspaceMessage; delivered: boolean}

export async function initializeWorkspaceMessages(fs: IFileSystem, directory: string, scope: WorkspaceMessageScope): Promise<void> {
    for (const name of ['inbox', 'outbox', 'artifacts']) {
        try {await fs.driver.createDirectory({parentPath: directory, name, recursive: true});}
        catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
    }
    const base = {schema: 'work-message/1', ...scope, types: ['progress', 'clarification', 'error', 'result'],
        publication: 'Write YAML to a temporary file, then atomically rename to inbox/<id>.yaml. Published messages are immutable.', maxBytes: 65536};
    const protocol = JSON.stringify({...base, message: {schema: 'work-message/1', ...scope, id: '<unique-id>',
        type: 'progress', content: '<message text, at most 8000 characters>'}, bodyAlias: 'Legacy body is accepted only when content is absent.'});
    if (await fs.driver.exists(directory + '/protocol.json')) {
        const existing = new TextDecoder('utf-8', {fatal: true}).decode(await readMessageBytes(fs, directory + '/protocol.json'));
        const legacyBase={...base,publication:'Write a temporary file, then atomically rename to inbox/<id>.json. Published messages are immutable.'};
        const legacyProtocol={...legacyBase,message:{schema:'work-message/1',...scope,id:'<unique-id>',type:'progress',content:'<message text, at most 8000 characters>'},bodyAlias:'Legacy body is accepted only when content is absent.'};
        if (existing !== protocol && existing !== JSON.stringify(base) && existing !== JSON.stringify(legacyBase) && existing !== JSON.stringify(legacyProtocol)) throw new FSError('ECONFLICT', 'Workspace protocol identity changed');
    } else await fs.driver.createFile({parentPath: directory, name: 'protocol.json', content: protocol});
}

/** Directory events are wakeups; immutable files plus durable receipts are authoritative. */
export async function consumeWorkspaceMessages(fs: IFileSystem, directory: string, scope: WorkspaceMessageScope, journal: Journal,
    deliver: (message: WorkspaceMessage) => Promise<void>): Promise<WorkspaceMessage[]> {
    const files = await fs.driver.getChildren(directory + '/inbox', {fields: 'entry'});
    if (files.length > 200) throw new FSError('EINVAL', 'Workspace inbox exceeds 200 entries');
    const messages: WorkspaceMessage[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (file.type !== 'file' || !/^[a-zA-Z0-9_-]{1,128}\.(yaml|yml|json)$/.test(file.name)) continue;
        const bytes = await readMessageBytes(fs, directory + '/inbox/' + file.name);
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        if ((parseSessionFile(text) as {schema?: string})?.schema === 'work-message/2') continue;
        const message = parseWorkspaceMessage(text, scope);
        if (file.name.slice(0,file.name.lastIndexOf('.')) !== message.id) throw new FSError('EINVAL', 'Workspace message filename does not match its identity');
        const digest = sha256HexSync(bytes), key = 'workspace-message:' + scope.attemptId + ':' + message.id;
        const receipt = await journal.update<Receipt>(key, old => {
            if (old && old.digest !== digest) throw new FSError('ECONFLICT', 'Published workspace message changed');
            return old ?? {digest, message, delivered: false};
        });
        if (!receipt.delivered) {
            await deliver(receipt.message);
            await journal.update<Receipt>(key, old => ({...old!, delivered: true}));
        }
        messages.push(receipt.message);
    }
    return messages;
}

export function parseWorkspaceMessage(text: string, scope: WorkspaceMessageScope): WorkspaceMessage {
    let value: WorkspaceMessage;
    try {value = parseSessionFile(text) as WorkspaceMessage;} catch {throw new FSError('EINVAL', 'Workspace message is not valid bounded YAML');}
    if (value && typeof value === 'object' && 'body' in value) {
        if (Object.hasOwn(value, 'content')) throw new FSError('EINVAL', 'Workspace message must not contain both body and content');
        value = {...value, content: (value as WorkspaceMessage & {body: string}).body};
    }
    if (!value || value.schema !== 'work-message/1' || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)
        || !['progress', 'clarification', 'error', 'result'].includes(value.type)
        || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 8000
        || value.replyTo !== undefined && (typeof value.replyTo !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.replyTo))
        || ['runId', 'itemId', 'attemptId'].some(key => value[key as keyof WorkspaceMessageScope] !== scope[key as keyof WorkspaceMessageScope]))
        throw new FSError('EINVAL', 'Workspace message schema or execution scope is invalid');
    return value;
}

/** Range reads must fit the advertised size; remote backends reject short ranges. */
async function readMessageBytes(fs: IFileSystem, path: string): Promise<ArrayBuffer> {
    const before = await fs.driver.getNode(path);
    if (before?.type !== 'file' || !Number.isSafeInteger(before.size) || before.size < 1) throw new FSError('EINVAL', 'Workspace message is not a nonempty regular file');
    if (before.size > 65536) throw new FSError('EINVAL', 'Workspace message exceeds 64 KiB');
    const bytes = await fs.driver.readContent(path, {encoding: 'binary', length: before.size});
    const after = await fs.driver.getNode(path);
    if (bytes.byteLength !== before.size || after?.type !== 'file' || after.size !== before.size
        || after.revision !== before.revision || after.modifiedAt !== before.modifiedAt)
        throw new FSError('ECONFLICT', 'Workspace message changed while reading');
    return bytes;
}

import {mkdir, lstat, readFile, open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {ToolOAuthApplicationInput} from '@itookit/app-contracts/services';
import {acquireHostLock} from '../storage/host-lock';
import {authFailure, validateOAuthRedirect} from './tool-oauth-client';

export interface OAuthApplication extends ToolOAuthApplicationInput {revision: string}
const updates = new Map<string, Promise<void>>();

/** Shared application identity is private host configuration, never a user token store. */
export class ToolOAuthApplications {
    constructor(private readonly directory: string) {}
    async get(type: string): Promise<OAuthApplication | undefined> {return (await this.read()).find(item => item.type === type);}
    save(input: ToolOAuthApplicationInput): Promise<void> {
        validateApplication(input);
        return this.mutate('save', records => {
            const previous = records.find(item => item.type === input.type);
            const record = {type: input.type, clientId: input.clientId.trim(), redirectUri: input.redirectUri, clientSecret: input.clientSecret || previous?.clientSecret || ''};
            const unchanged = previous && previous.clientId === record.clientId && previous.clientSecret === record.clientSecret && previous.redirectUri === record.redirectUri;
            return [...records.filter(item => item.type !== input.type), {...record, revision: unchanged ? previous.revision : randomUUID()}];
        });
    }
    remove(type: string): Promise<void> {return this.mutate('remove', records => records.filter(item => item.type !== type));}
    private async read(): Promise<OAuthApplication[]> {
        await mkdir(this.directory, {recursive: true, mode: 0o700}); await checkPrivate(this.directory, true);
        const file = path.join(this.directory, 'applications.json');
        try {
            await checkPrivate(file); const stat = await lstat(file);
            if (stat.size > 256 * 1024) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_INVALID');
            const data: unknown = JSON.parse(await readFile(file, 'utf8'));
            if (!Array.isArray(data) || data.length > 100) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_INVALID');
            for (const record of data) {validateApplication(record); if (typeof record.revision !== 'string' || !record.revision) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_INVALID');}
            if (new Set(data.map(item => item.type)).size !== data.length) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_INVALID');
            return data;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            if ((error as {code?: string})?.code?.startsWith('TOOL_AUTH_')) throw error;
            if (error instanceof SyntaxError) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_INVALID');
            if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_DENIED');
            throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_FAILED');
        }
    }
    private mutate(action: string, change: (records: OAuthApplication[]) => OAuthApplication[]): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        const work = (updates.get(this.directory) ?? Promise.resolve()).then(async () => {
            await this.read(); const release = await acquireHostLock(path.join(this.directory, 'write-lock'));
            try {const records = change(await this.read()); if (records.length > 100) throw authFailure('TOOL_AUTH_APPLICATION_LIMIT'); await this.write(records);}
            finally {await release();}
        });
        const observed = work.then(() => {console.info('[ToolOAuthApplications]', {operation: action, operationId, stage: 'persist', result: 'success', durationMs: Date.now() - started});}, error => {
            const code = (error as {code?: string})?.code;
            const safe = code?.startsWith('TOOL_AUTH_') ? code : code === 'HOST_LOCK_BUSY' ? 'TOOL_AUTH_APPLICATION_BUSY'
                : code === 'EACCES' || code === 'EPERM' ? 'TOOL_AUTH_APPLICATION_STORAGE_DENIED' : 'TOOL_AUTH_APPLICATION_STORAGE_FAILED';
            console.warn('[ToolOAuthApplications]', {operation: action, operationId, stage: 'persist', result: 'failure', code: safe, durationMs: Date.now() - started}); throw authFailure(safe);
        });
        const drained = observed.catch(() => {}); updates.set(this.directory, drained);
        void drained.then(() => {if (updates.get(this.directory) === drained) updates.delete(this.directory);}); return observed;
    }
    private async write(records: OAuthApplication[]): Promise<void> {
        const content = JSON.stringify(records);
        if (Buffer.byteLength(content) > 256 * 1024) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_TOO_LARGE');
        const temporary = path.join(this.directory, randomUUID() + '.tmp');
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {await handle.writeFile(content); await handle.sync();} finally {await handle.close();}
            await rename(temporary, path.join(this.directory, 'applications.json'));
            const directory = await open(this.directory, 'r'); try {await directory.sync();} finally {await directory.close();}
        } finally {await unlink(temporary).catch(() => {});}
    }
}
function validateApplication(input: ToolOAuthApplicationInput): void {
    if (!input || !/^[a-z][a-z0-9.-]{0,79}$/.test(input.type) || typeof input.clientId !== 'string' || !input.clientId.trim() || input.clientId.length > 16384
        || input.clientSecret !== undefined && (typeof input.clientSecret !== 'string' || input.clientSecret.length > 16384)) throw authFailure('TOOL_AUTH_APPLICATION_INVALID');
    validateOAuthRedirect(input.redirectUri);
}
async function checkPrivate(file: string, directory = false): Promise<void> {
    const info = await lstat(file);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
        || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw authFailure('TOOL_AUTH_APPLICATION_STORAGE_NOT_PRIVATE');
}

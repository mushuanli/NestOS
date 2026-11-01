import {mkdir, lstat, readFile, open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {ToolConnectionAccess, ToolConnectionInput, ToolConnectionType, ToolOAuthApplicationInput, ToolConnectionVerification} from '@itookit/app-contracts/services';
import {ToolAuthorization, type PrivateConnection} from './tool-authorization';
import {validateOAuth} from './tool-oauth-client';
import {ToolOAuthApplications} from './tool-oauth-applications';
import {bindOAuthApplication, connectionValues, usesApplication, type OAuthConnectionRecord as ConnectionRecord} from './tool-oauth-binding';

const failure = (code: string) => Object.assign(new Error(code), {code});
const verificationCode = (error: unknown): string => /^(TOOL_AUTH|TOOL_CONNECTION)_[A-Z_]+$/.test((error as {code?: string})?.code ?? '') ? (error as {code: string}).code : 'TOOL_CONNECTION_VERIFICATION_FAILED';
function publicVerification(value: ConnectionRecord['verification'], revision?: string): ToolConnectionVerification | undefined {
    if (!value || value.revision !== revision || !['verified', 'failed', 'unsupported'].includes(value.status)
        || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) || value.checkedAt < 0 || value.checkedAt > 8.64e15) return;
    return {status: value.status, checkedAt: value.checkedAt, ...(typeof value.code === 'string' && /^(TOOL_AUTH|TOOL_CONNECTION)_[A-Z_]+$/.test(value.code) ? {code: value.code} : {})};
}
export function validateToolConnectionDefinition(type: ToolConnectionType): void {
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(type.id) || !type.fields.length
        || new Set(type.fields.map(field => field.name)).size !== type.fields.length
        || type.fields.some(field => !/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(field.name))) throw failure('TOOL_CONNECTION_TYPE_INVALID');
    validateOAuth(type);
}
/** Created per runtime from its private auth directory; caller input never selects a user or path. */
export class NodeToolConnections implements ToolConnectionAccess {
    private readonly types = new Map<string, ToolConnectionType>();
    private tail = Promise.resolve();
    private readonly authorization: ToolAuthorization;
    private readonly applications?: ToolOAuthApplications;
    private readonly canManageApplications: boolean;
    constructor(private readonly directory: string, options: {redirectUri?: string; fetcher?: typeof fetch; applications?: ToolOAuthApplications; manageApplications?: boolean} = {}) {
        this.applications = options.applications; this.canManageApplications = options.manageApplications === true;
        this.authorization = new ToolAuthorization({get: id => this.privateRecord(id), definition: type => this.types.get(type),
            patch: (id, revision, patch, scopes) => this.patchTokens(id, revision, patch, scopes)}, options.redirectUri, options.fetcher);
    }
    beginAuthorization(id: string, groups: string[], operationId: string) {return this.authorization.begin(id, groups, operationId);}
    async authorizationStatus(operationId: string) {return this.authorization.status(operationId);}
    async cancelAuthorization(operationId: string) {this.authorization.cancel(operationId);}
    revokeAuthorization(id: string) {return this.authorization.revoke(id);}
    completeAuthorization(callback: {state: string; code?: string; error?: string}) {return this.authorization.complete(callback);}
    accessToken(id: string, type: string) {return this.authorization.accessToken(id, type);}
    close() {return this.authorization.close();}
    async saveApplication(input: ToolOAuthApplicationInput): Promise<void> {
        return this.applicationChange('save-application', async () => {
            this.assertApplicationAdmin(); const type = this.types.get(input?.type);
            if (!type?.authorization) throw failure('TOOL_AUTH_UNSUPPORTED');
            const previous = await this.applications!.get(input.type);
            if (type.authorization.clientSecretField && !input.clientSecret && !previous?.clientSecret) throw failure('TOOL_AUTH_CLIENT_REQUIRED');
            await this.applications!.save(input);
        });
    }
    async removeApplication(type: string): Promise<void> {return this.applicationChange('remove-application', async () => {this.assertApplicationAdmin(); await this.applications!.remove(type);});}
    private async applicationChange(operation: string, work: () => Promise<void>): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        try {await work(); console.info('[ToolConnections]', {operation, operationId, stage: 'application', result: 'success', durationMs: Date.now() - started});}
        catch (error) {
            const code = (error as {code?: string})?.code;
            console.warn('[ToolConnections]', {operation, operationId, stage: 'application', result: 'failure', code: code && /^TOOL_AUTH_[A-Z_]+$/.test(code) ? code : 'TOOL_AUTH_APPLICATION_FAILED', durationMs: Date.now() - started}); throw error;
        }
    }
    private assertApplicationAdmin(): void {
        if (!this.canManageApplications) throw failure('TOOL_AUTH_APPLICATION_ADMIN_REQUIRED');
        if (!this.applications) throw failure('TOOL_AUTH_APPLICATION_UNAVAILABLE');
    }
    register(type: ToolConnectionType): void {
        validateToolConnectionDefinition(type); this.types.set(type.id, structuredClone(type));
    }
    prepareRegistration(types: ToolConnectionType[]) {
        for (const type of types) validateToolConnectionDefinition(type);
        const previous = new Map(this.types), next = types.map(type => structuredClone(type)); let committed = false;
        return {commit: () => {for (const type of next) this.types.set(type.id, type); committed = true;},
            rollback: () => {if (committed) {this.types.clear(); for (const [id, type] of previous) this.types.set(id, type); committed = false;}}};
    }
    async snapshot() {
        const records = await this.read();
        const applications = new Map(await Promise.all([...this.types.keys()].map(async id => [id, await this.applications?.get(id)] as const)));
        return {authorizationRedirectUri: this.authorization.redirectUri, types: [...this.types.values()].map(type => {
            const application = applications.get(type.id);
            return {...structuredClone(type), ...(type.authorization && this.applications ? {application: {configured: Boolean(application), canManage: this.canManageApplications,
                redirectUri: application?.redirectUri, ...(this.canManageApplications ? {clientId: application?.clientId, hasSecret: Boolean(application?.clientSecret)} : {})}} : {})};
        }), connections: records.map(record => {
            const type = this.types.get(record.type), fields = type?.fields ?? [];
            const application = applications.get(record.type), managed = type && usesApplication(record, type, application);
            const connected = type?.authorization && Boolean(record.values[type.authorization.refreshTokenField]) && (!managed || Boolean(application && record.oauthApplicationRevision === application.revision));
            const revision = managed ? application && `${record.revision ?? ''}:${application.revision}` : record.revision;
            const verification = publicVerification(record.verification, revision);
            return {id: record.id, type: record.type, name: record.name,
                ...(verification && (!managed || application) ? {verification} : {}),
                ...(type?.authorization ? {authorization: {scopes: connected ? record.authorizedScopes ?? [] : [], connected: Boolean(connected), clientMode: managed ? 'application' as const : 'personal' as const, operation: this.authorization.current(record.id)}} : {}),
                values: Object.fromEntries(fields.filter(field => !field.secret).map(field => [field.name, record.values[field.name] ?? ''])),
                configuredSecrets: fields.filter(field => field.secret && record.values[field.name]).map(field => field.name)};
        })};
    }
    async resolve(id: string, type: string): Promise<Record<string, string>> {
        const record = await this.privateRecord(id); if (record.type !== type) throw failure('TOOL_CONNECTION_NOT_FOUND');
        const values = {...record.values}, definition = this.types.get(type)?.authorization;
        if (record.redirectUri && definition?.clientSecretField) delete values[definition.clientSecretField];
        return values;
    }
    save(input: ToolConnectionInput): Promise<void> {
        return this.mutate('save', async records => {
            const type = this.types.get(input?.type);
            if (!type || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.id) || !input.name?.trim()
                || input.name.length > 200 || !input.values || typeof input.values !== 'object') throw failure('TOOL_CONNECTION_INVALID');
            const previous = records.find(record => record.id === input.id);
            if (previous && previous.type !== input.type) throw failure('TOOL_CONNECTION_TYPE_CONFLICT');
            if (Object.keys(input.values).some(key => !type.fields.some(field => field.name === key))) throw failure('TOOL_CONNECTION_FIELD_INVALID');
            const application = await this.applications?.get(type.id), values = connectionValues(input, type, previous, application);
            const auth = type.authorization, credentialFields = auth ? [auth.clientIdField, auth.clientSecretField, auth.refreshTokenField].filter(Boolean) : type.fields.map(field => field.name);
            const unchanged = previous && credentialFields.every(name => previous.values[name!] === values[name!]);
            const managed = usesApplication({...input, values, oauthApplicationRevision: previous?.oauthApplicationRevision}, type, application);
            return [...records.filter(record => record.id !== input.id), {...previous, verification: undefined, id: input.id, type: input.type, name: input.name.trim(), values, revision: randomUUID(), authorizedScopes: unchanged ? previous.authorizedScopes : undefined,
                ...(managed ? {oauthApplicationRevision: previous?.oauthApplicationRevision ?? application?.revision} : {})}];
        }).then(() => {this.authorization.invalidate(input.id);});
    }
    remove(id: string): Promise<void> {return this.mutate('remove', records => records.filter(record => record.id !== id)).then(() => {this.authorization.invalidate(id);});}
    async verify(id: string): Promise<ToolConnectionVerification> {
        const operationId = randomUUID(), started = Date.now(); let stage = 'validate-id';
        const connectionId = typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id) ? id : undefined;
        try {
            if (!connectionId) throw failure('TOOL_CONNECTION_INVALID');
            stage = 'load-connection';
            const record = await this.privateRecord(id); let revision = record.revision;
            let result: ToolConnectionVerification = {status: 'unsupported', checkedAt: Date.now()};
            if (this.types.get(record.type)?.authorization) {
                stage = 'token-refresh';
                try {revision = await this.authorization.verify(id, record.type); result = {status: 'verified', checkedAt: Date.now()};}
                catch (error) {result = {status: 'failed', checkedAt: Date.now(), code: verificationCode(error)};}
            }
            stage = 'persist-verification'; await this.saveVerification(id, revision, result);
            console.info('[ToolConnections]', {operation: 'verify', operationId, connectionId, stage, result: result.status, code: result.code, durationMs: Date.now() - started});
            return result;
        } catch (error) {
            console.warn('[ToolConnections]', {operation: 'verify', operationId, connectionId, stage, result: 'failure', code: verificationCode(error), durationMs: Date.now() - started}); throw error;
        }
    }
    private saveVerification(id: string, revision: string | undefined, verification: ToolConnectionVerification): Promise<void> {
        return this.mutate('verify', async records => {
            const record = records.find(row => row.id === id), type = record && this.types.get(record.type);
            if (!record || !type) throw failure('TOOL_CONNECTION_NOT_FOUND');
            const bound = bindOAuthApplication(record, type, await this.applications?.get(type.id));
            if (bound.revision !== revision) throw failure('TOOL_AUTH_CONNECTION_CHANGED');
            return records.map(row => row.id === id ? {...row, verification: {...verification, revision}} : row);
        });
    }
    private async privateRecord(id: string): Promise<PrivateConnection> {
        const record = (await this.read()).find(item => item.id === id);
        const type = record && this.types.get(record.type);
        if (!record || !type) throw failure('TOOL_CONNECTION_NOT_FOUND');
        return bindOAuthApplication(record, type, await this.applications?.get(record.type));
    }
    private async patchTokens(id: string, revision: string | undefined, patch: Record<string, string>, scopes?: string[]): Promise<PrivateConnection> {
        let written!: PrivateConnection;
        await this.mutate('authorization', async records => {
            if (!records.some(record => record.id === id)) throw failure('TOOL_CONNECTION_NOT_FOUND');
            const original = records.find(record => record.id === id)!, type = this.types.get(original.type)!;
            const application = await this.applications?.get(original.type);
            if (bindOAuthApplication(original, type, application).revision !== revision) throw failure('TOOL_AUTH_CONNECTION_CHANGED');
            return records.map(record => {
            if (record.id !== id) return record;
            const updated = {...record, revision: randomUUID(), values: {...record.values, ...patch}, ...(scopes ? {authorizedScopes: scopes} : {}),
                ...(usesApplication(record, type, application) ? {oauthApplicationRevision: application!.revision} : {})};
            written = bindOAuthApplication(updated, type, application); return updated;
            });
        }); return written;
    }
    private async read(): Promise<ConnectionRecord[]> {
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
    private mutate(action: string, change: (records: ConnectionRecord[]) => ConnectionRecord[] | Promise<ConnectionRecord[]>): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        const operation = this.tail.then(async () => {
            const records = await change(await this.read()), temporary = path.join(this.directory, randomUUID() + '.tmp');
            try {
                const handle = await open(temporary, 'wx', 0o600);
                try {await handle.writeFile(JSON.stringify(records)); await handle.sync();} finally {await handle.close();}
                await rename(temporary, path.join(this.directory, 'connections.json'));
                const handleDirectory = await open(this.directory, 'r');
                try {await handleDirectory.sync();} finally {await handleDirectory.close();}
            } finally {await unlink(temporary).catch(() => {});}
        });
        const observed = operation.then(() => {console.info('[ToolConnections]', {operation: action, operationId, stage: 'persist', result: 'success', durationMs: Date.now() - started});}, error => {
            console.warn('[ToolConnections]', {operation: action, operationId, stage: 'persist', result: 'failure', code: /^TOOL_(CONNECTION|AUTH)_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'TOOL_CONNECTION_STORAGE_FAILED', durationMs: Date.now() - started});
            throw error;
        });
        this.tail = observed.catch(() => {}); return observed;
    }
}

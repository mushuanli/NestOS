import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {ToolAuthorizationView, ToolConnectionType, ToolOAuthDefinition} from '@itookit/app-contracts/services';
import {authFailure, tokenRequest, validateOAuthRedirect, type OAuthTokenReply} from './tool-oauth-client';

export interface PrivateConnection {id: string; type: string; revision?: string; redirectUri?: string; authorizedScopes?: string[]; values: Record<string, string>}
export interface AuthorizationStore {
    get(id: string): Promise<PrivateConnection>;
    definition(type: string): ToolConnectionType | undefined;
    patch(id: string, revision: string | undefined, patch: Record<string, string>, scopes?: string[]): Promise<PrivateConnection>;
}
interface Attempt {view: ToolAuthorizationView; state: string; verifier: string; redirectUri: string; record: PrivateConnection; definition: ToolOAuthDefinition; scopes: string[]; work?: Promise<void>}
interface CachedToken {value: string; expiresAt: number; revision?: string}
const secret = () => randomBytes(32).toString('base64url');

/** One authenticated user owns pending states, single-flight refreshes and token cache. */
export class ToolAuthorization {
    private readonly attempts = new Map<string, Attempt>();
    private readonly tokens = new Map<string, CachedToken>();
    private readonly refreshes = new Map<string, Promise<string>>();
    private closed = false;
    private preparing: Promise<void> = Promise.resolve();
    constructor(private readonly store: AuthorizationStore, readonly redirectUri?: string, private readonly fetcher = fetch) {
        if (redirectUri) validateOAuthRedirect(redirectUri);
    }
    begin(id: string, groups: string[], operationId: string): Promise<ToolAuthorizationView> {
        const work = this.preparing.then(() => this.prepareBegin(id, groups, operationId));
        this.preparing = work.then(() => {}, () => {}); return work;
    }
    private async prepareBegin(id: string, groups: string[], operationId: string): Promise<ToolAuthorizationView> {
        if (this.closed) throw authFailure('TOOL_AUTH_CLOSED');
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) throw authFailure('TOOL_AUTH_OPERATION_INVALID');
        this.prune(); const old = this.attempts.get(operationId);
        if (old) {if (old.record.id !== id || JSON.stringify(old.scopes) !== JSON.stringify(this.scopes(old.definition, groups))) throw authFailure('TOOL_AUTH_OPERATION_CONFLICT'); return this.view(old);}
        if (this.attempts.size >= 100) throw authFailure('TOOL_AUTH_OPERATION_LIMIT');
        const record = await this.store.get(id), definition = this.definition(record), scopes = this.scopes(definition, groups);
        const redirectUri = record.redirectUri ?? this.redirectUri;
        if (!redirectUri) throw authFailure('TOOL_AUTH_REDIRECT_UNCONFIGURED');
        validateOAuthRedirect(redirectUri);
        if (this.closed) throw authFailure('TOOL_AUTH_CLOSED');
        if (!record.values[definition.clientIdField] || definition.clientSecretField && !record.values[definition.clientSecretField]) throw authFailure('TOOL_AUTH_CLIENT_REQUIRED');
        for (const attempt of this.attempts.values()) if (attempt.record.id === id && ['pending', 'exchanging'].includes(attempt.view.status)) this.cancel(attempt.view.operationId);
        const attempt: Attempt = {record, definition, scopes, redirectUri, state: secret(), verifier: secret(),
            view: {operationId, connectionId: id, status: 'pending', expiresAt: Date.now() + 10 * 60000}};
        const url = new URL(definition.authorizationEndpoint);
        url.search = new URLSearchParams({...definition.authorizationParameters, client_id: record.values[definition.clientIdField], redirect_uri: redirectUri,
            response_type: 'code', scope: scopes.join(' '), state: attempt.state, code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'), code_challenge_method: 'S256'}).toString();
        attempt.view.url = url.href; this.attempts.set(operationId, attempt); this.report(attempt, 'begin', 'success'); return this.view(attempt);
    }
    status(operationId: string): ToolAuthorizationView {
        const attempt = this.attempts.get(operationId); if (!attempt) throw authFailure('TOOL_AUTH_OPERATION_NOT_FOUND');
        return this.view(attempt);
    }
    current(id: string): ToolAuthorizationView | undefined {const attempt = [...this.attempts.values()].reverse().find(item => item.record.id === id); return attempt && this.view(attempt);}
    cancel(operationId: string): void {
        const attempt = this.attempts.get(operationId); if (!attempt) return;
        if (['pending', 'exchanging'].includes(attempt.view.status)) {attempt.view.status = 'cancelled'; delete attempt.view.url; this.report(attempt, 'cancel', 'success');}
    }
    async complete(callback: {state: string; code?: string; error?: string}): Promise<void> {
        const attempt = [...this.attempts.values()].find(item => item.state === callback.state);
        if (!attempt) throw authFailure('TOOL_AUTH_STATE_INVALID');
        const status = this.view(attempt).status;
        if (status === 'authorized') return;
        if (!['pending', 'exchanging'].includes(status)) throw authFailure('TOOL_AUTH_' + status.toUpperCase());
        if (attempt.work) return attempt.work;
        if (callback.error || !callback.code || callback.code.length > 16384) {attempt.view.status = 'failed'; attempt.view.code = 'TOOL_AUTH_DECLINED'; throw authFailure('TOOL_AUTH_DECLINED');}
        attempt.view.status = 'exchanging'; delete attempt.view.url;
        const work = this.exchange(attempt, callback.code); attempt.work = work;
        void work.then(() => {attempt.work = undefined;}, () => {attempt.work = undefined;}); return work;
    }
    private async exchange(attempt: Attempt, code: string): Promise<void> {
        const started = Date.now();
        try {
            const token = await tokenRequest(attempt.definition, attempt.record.values, {grant_type: 'authorization_code', code,
                code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri}, this.fetcher);
            if (this.view(attempt).status !== 'exchanging' || this.closed) throw authFailure('TOOL_AUTH_CANCELLED');
            const refresh = token.refresh_token ?? attempt.record.values[attempt.definition.refreshTokenField];
            if (!refresh) throw authFailure('TOOL_AUTH_REFRESH_TOKEN_REQUIRED');
            const scopes = token.scope ? token.scope.split(' ').filter(Boolean) : attempt.scopes;
            if (attempt.scopes.some(scope => !scopes.includes(scope))) throw authFailure('TOOL_AUTH_SCOPE_NOT_GRANTED');
            const saved = await this.store.patch(attempt.record.id, attempt.record.revision, {[attempt.definition.refreshTokenField]: refresh}, scopes);
            if (this.view(attempt).status !== 'exchanging' || this.closed) {
                await this.store.patch(saved.id, saved.revision, {[attempt.definition.refreshTokenField]: attempt.record.values[attempt.definition.refreshTokenField] ?? ''}, attempt.record.authorizedScopes ?? []).catch(() => {});
                throw authFailure('TOOL_AUTH_CANCELLED');
            }
            const current = await this.store.get(attempt.record.id);
            if (current.revision !== saved.revision) throw authFailure('TOOL_AUTH_CONNECTION_CHANGED');
            this.cache(current, token);
            attempt.view.status = 'authorized'; this.report(attempt, 'exchange', 'success', started);
        } catch (error) {
            if (!['cancelled', 'expired'].includes(attempt.view.status)) attempt.view.status = 'failed';
            attempt.view.code = this.code(error); this.report(attempt, 'exchange', 'failure', started); throw authFailure(attempt.view.code);
        } finally {attempt.verifier = '';}
    }
    async verify(id: string, type: string): Promise<string | undefined> {
        await this.accessToken(id, type, true);
        const token = this.tokens.get(id), current = await this.store.get(id);
        if (!token || token.revision !== current.revision) throw authFailure('TOOL_AUTH_CONNECTION_CHANGED');
        return token.revision;
    }
    async accessToken(id: string, type: string, forceRefresh = false): Promise<string> {
        if (this.closed) throw authFailure('TOOL_AUTH_CLOSED');
        const record = await this.store.get(id); if (record.type !== type) throw authFailure('TOOL_CONNECTION_NOT_FOUND');
        const cached = this.tokens.get(id);
        if (!forceRefresh && cached && cached.revision === record.revision && cached.expiresAt > Date.now() + 30000) return cached.value;
        const existing = this.refreshes.get(id); if (existing) return existing;
        const work = this.diagnose('refresh', () => this.refresh(record)).finally(() => {if (this.refreshes.get(id) === work) this.refreshes.delete(id);});
        this.refreshes.set(id, work); return work;
    }
    private async refresh(record: PrivateConnection): Promise<string> {
        const definition = this.definition(record), refresh = record.values[definition.refreshTokenField];
        if (!refresh) throw authFailure('TOOL_AUTH_REAUTHORIZE_REQUIRED');
        const token = await tokenRequest(definition, record.values, {grant_type: 'refresh_token', refresh_token: refresh}, this.fetcher);
        const saved = token.refresh_token ? await this.store.patch(record.id, record.revision, {[definition.refreshTokenField]: token.refresh_token}) : record;
        if (this.closed) throw authFailure('TOOL_AUTH_CLOSED');
        const current = await this.store.get(record.id);
        if (current.revision !== saved.revision) throw authFailure('TOOL_AUTH_CONNECTION_CHANGED');
        this.cache(current, token); return token.access_token;
    }
    async revoke(id: string): Promise<void> {
        return this.diagnose('revoke', () => this.performRevoke(id));
    }
    private async performRevoke(id: string): Promise<void> {
        const record = await this.store.get(id), definition = this.definition(record); this.invalidate(id);
        const token = record.values[definition.refreshTokenField];
        if (definition.revocationEndpoint && token) {
            let response: Response;
            try {response = await this.fetcher(definition.revocationEndpoint, {method: 'POST', body: new URLSearchParams({token}), redirect: 'error', signal: AbortSignal.timeout(30000)});}
            catch {throw authFailure('TOOL_AUTH_REVOCATION_TRANSPORT_FAILED');}
            await response.body?.cancel(); if (!response.ok) throw authFailure('TOOL_AUTH_REVOCATION_REJECTED');
        }
        await this.store.patch(id, record.revision, {[definition.refreshTokenField]: ''}, []);
    }
    invalidate(id: string): void {this.tokens.delete(id); for (const attempt of this.attempts.values()) if (attempt.record.id === id) this.cancel(attempt.view.operationId);}
    async close(): Promise<void> {this.closed = true; for (const attempt of this.attempts.values()) this.cancel(attempt.view.operationId); await Promise.allSettled([...this.refreshes.values(), ...[...this.attempts.values()].flatMap(item => item.work ? [item.work] : [])]); this.tokens.clear();}
    private cache(record: PrivateConnection, token: OAuthTokenReply): void {this.tokens.set(record.id, {value: token.access_token, revision: record.revision, expiresAt: Date.now() + Math.min(token.expires_in ?? 300, 86400) * 1000});}
    private definition(record: PrivateConnection): ToolOAuthDefinition {const value = this.store.definition(record.type)?.authorization; if (!value) throw authFailure('TOOL_AUTH_UNSUPPORTED'); return value;}
    private scopes(definition: ToolOAuthDefinition, groups: string[]): string[] {
        if (!Array.isArray(groups) || !groups.length || groups.some(id => !definition.permissionGroups.some(group => group.id === id))) throw authFailure('TOOL_AUTH_SCOPE_INVALID');
        return [...new Set(definition.permissionGroups.filter(group => groups.includes(group.id)).flatMap(group => group.scopes))].sort();
    }
    private view(attempt: Attempt): ToolAuthorizationView {if (Date.now() >= attempt.view.expiresAt && ['pending', 'exchanging'].includes(attempt.view.status)) {attempt.view.status = 'expired'; delete attempt.view.url;} return {...attempt.view};}
    private prune(): void {for (const [id, attempt] of this.attempts) if (Date.now() > attempt.view.expiresAt + 600000 && !attempt.work) this.attempts.delete(id);}
    private code(error: unknown): string {const code = (error as {code?: string})?.code; return code && /^(TOOL_AUTH|TOOL_CONNECTION)_[A-Z_]+$/.test(code) ? code : 'TOOL_AUTH_FAILED';}
    private async diagnose<T>(stage: string, work: () => Promise<T>): Promise<T> {
        const operationId = randomUUID(), started = Date.now();
        try {
            const value = await work();
            console.info('[ToolAuthorization]', {operation: 'authorize', operationId, stage, result: 'success', durationMs: Date.now() - started}); return value;
        } catch (error) {
            console.warn('[ToolAuthorization]', {operation: 'authorize', operationId, stage, result: 'failure', code: this.code(error), durationMs: Date.now() - started}); throw error;
        }
    }
    private report(attempt: Attempt, stage: string, result: string, started = Date.now()): void {console.info('[ToolAuthorization]', {operation: 'authorize', operationId: attempt.view.operationId, stage, result, code: attempt.view.code, durationMs: Date.now() - started});}
}

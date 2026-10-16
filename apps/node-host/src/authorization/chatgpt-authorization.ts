import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createChatGPTAuthSession, ChatGPTError } from '@itookit/driver-llm';
import type { ChatGPTConfig } from '@itookit/driver-llm/contracts';
import type { ProviderAuthorizationHost } from '@itookit/kernel-adapters/llm/core';
import type { ProviderAuthorizationState } from '@itookit/kernel-adapters/contracts';
import { PrivateAuthStore, type Registration } from './private-store';
import { OpenAIOidc, OpenAIAuthorizationError, type OAuthTokens } from './openai-oidc';
import type { AuditPort } from '../logging/audit-log';
import { reportAuthorizationFailure, type AuthorizationStage } from './authorization-diagnostics';

interface Attempt {
    id: string; state: string; nonce: string; verifier: string; callbackUri: string;
    server: Server; expiresAt: number; timer: ReturnType<typeof setTimeout>; url: string; cancelled: boolean;
}
const secret = () => randomBytes(32).toString('base64url');

/** One private host service is shared by all browser views and driver instances. */
export class ChatGPTAuthorization implements ProviderAuthorizationHost {
    private readonly pending = new Map<string, Attempt>();
    private readonly sessions = new Map<string, ChatGPTConfig>();
    private readonly issues = new Map<string, string>();
    private readonly listeners = new Set<() => void>();
    private readonly operations = new Map<string, Promise<unknown>>();
    private closed = false;
    constructor(private readonly store: PrivateAuthStore, private readonly oidc = new OpenAIOidc(),
        private readonly audit?: Pick<AuditPort, 'write'>) {}
    onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    state(id: string): ProviderAuthorizationState {
        const record = this.store.get(id), attempt = this.pending.get(id), issue = this.issues.get(id);
        return { supported: true, status: attempt ? 'pending' : issue === 'reauthorization-required' ? 'reauthorize'
            : record?.tokens ? 'authorized' : 'signed-out', account: record?.email, issue,
            pending: attempt && { id: attempt.id, url: attempt.url, callbackUri: attempt.callbackUri, expiresAt: attempt.expiresAt } };
    }
    begin(id: string): Promise<ProviderAuthorizationState> {
        return this.serial(id, async () => {
            if (this.pending.has(id)) return this.state(id);
            if (this.pending.size >= 4) throw new Error('Too many pending ChatGPT sign-ins');
            const attempt = await this.createAttempt(id);
            if (this.closed) { clearTimeout(attempt.timer); attempt.server.close(); throw new Error('Authorization host is closed'); }
            this.pending.set(id, attempt); this.issues.delete(id); this.changed(); return this.state(id);
        });
    }
    complete(id: string, attemptId: string, callbackUrl: string): Promise<ProviderAuthorizationState> {
        return this.serial(id, async () => {
            const attempt = this.pending.get(id);
            if (!attempt || attempt.id !== attemptId || attempt.cancelled || attempt.expiresAt <= Date.now()) throw new Error('ChatGPT sign-in expired');
            const callback = validateCallback(attempt, callbackUrl);
            if (callback.get('error')) { await this.finish(id, attempt, 'consent-denied'); return this.state(id); }
            try { await this.exchange(id, attempt, callback); }
            catch { await this.finish(id, attempt, 'authorization-failed'); return this.state(id); }
            await this.finish(id, attempt); return this.state(id);
        });
    }
    async cancel(id: string): Promise<ProviderAuthorizationState> {
        const attempt = this.pending.get(id);
        if (attempt) { attempt.cancelled = true; await this.finish(id, attempt); }
        return this.state(id);
    }
    async disconnect(id: string): Promise<ProviderAuthorizationState> {
        await this.cancel(id);
        return this.serial(id, async () => {
            const record = this.store.get(id); let revoked = true;
            if (record?.tokens) revoked = await this.oidc.revoke(record.clientId, record.tokens.refreshToken);
            if (record) await this.store.put({ ...record, tokens: undefined });
            this.issues.delete(id);
            if (!revoked) this.issues.set(id, 'revocation-unconfirmed');
            this.changed(); return this.state(id);
        });
    }
    credentials(id: string): ChatGPTConfig {
        let config = this.sessions.get(id);
        if (!config) {
            config = { session: createChatGPTAuthSession({ read: async () => this.access(id), refresh: () => this.refresh(id) }) };
            this.sessions.set(id, config);
        }
        return config;
    }
    async close(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.pending.keys()].map(id => this.cancel(id)));
        await Promise.allSettled([...this.operations.values()]);
        this.listeners.clear(); this.sessions.clear();
    }
    private access(id: string) {
        const tokens = this.store.get(id)?.tokens;
        if (!tokens) throw new ChatGPTError('reauthorization_required', 401);
        return { accessToken: tokens.accessToken, scopes: tokens.scopes, expiresAt: tokens.expiresAt };
    }
    private refresh(id: string) {
        return this.serial(id, async () => {
            const record = this.store.get(id);
            if (!record?.tokens) throw new ChatGPTError('reauthorization_required', 401);
            try {
                const response = await this.oidc.exchange({ grant_type: 'refresh_token', client_id: record.clientId,
                    refresh_token: record.tokens.refreshToken });
                const tokens = validateTokens(response, record.tokens);
                if (response.id_token) {
                    const identity = await this.oidc.verify(response.id_token, record.clientId);
                    if (identity.subject !== record.subject) throw new Error('ChatGPT account changed during refresh');
                }
                await this.store.put({ ...record, tokens }); this.issues.delete(id); this.changed(); return this.access(id);
            } catch (error) {
                const transient = error instanceof OpenAIAuthorizationError && (!error.status || error.status >= 500 || error.status === 429);
                this.issues.set(id, transient ? 'refresh-unavailable' : 'reauthorization-required'); this.changed();
                throw new ChatGPTError(transient ? 'refresh_unavailable' : 'reauthorization_required', transient ? 503 : 401);
            }
        });
    }
    private callbackServer(id: string): Server {
        const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
            const attempt = this.pending.get(id);
            let callback: URL | undefined;
            try { callback = attempt && new URL(request.url ?? '/', attempt.callbackUri); } catch { /* Reject malformed URLs below. */ }
            if (!attempt || !callback || callback.pathname !== '/auth/callback' || request.method !== 'GET') {
                response.writeHead(404); response.end(); return;
            }
            void this.complete(id, attempt.id, callback.href).then(state => {
                response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
                response.end(state.status === 'authorized' && !state.issue ? 'Sign-in completed. Return to MindOS.'
                    : 'Sign-in did not complete. Return to MindOS. Check the server audit log for provider.authorization.failed.');
            }).catch(() => { response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end('Invalid sign-in callback.'); });
        });
        server.maxConnections = 8; server.headersTimeout = 10_000; server.requestTimeout = 15_000;
        return server;
    }
    private async createAttempt(id: string): Promise<Attempt> {
        const url = await this.oidc.authorizeURL(), previous = this.store.get(id);
        const server = this.callbackServer(id);
        const port = await listen(server);
        const values = { id: secret(), state: secret(), nonce: secret(), verifier: secret(), callbackUri: `http://127.0.0.1:${port}/auth/callback` };
        const parameters = { client_id: previous?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.store.hostId,
            response_type: 'code', redirect_uri: values.callbackUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
            resource: 'https://api.openai.com/v1', state: values.state, nonce: values.nonce, code_challenge_method: 'S256',
            code_challenge: createHash('sha256').update(values.verifier).digest('base64url'),
            ...(!previous ? { agent_name_hint: 'MindOS' } : {}) };
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
        const attempt: Attempt = { ...values, server, url: url.href, cancelled: false, expiresAt: Date.now() + 600_000,
            timer: setTimeout(() => { void this.cancel(id); }, 600_000) };
        attempt.timer.unref(); return attempt;
    }
    private async exchange(id: string, attempt: Attempt, callback: URLSearchParams): Promise<void> {
        const startedAt = Date.now(); let stage: AuthorizationStage = 'client.validate';
        try {
            const previous = this.store.get(id), issued = callback.get('client_id') ?? previous?.clientId;
            if (!issued || issued === 'dynamic_agent_client' || (previous && issued !== previous.clientId)) throw new Error('Invalid issued ChatGPT client');
            stage = 'token.exchange';
            const response = await this.oidc.exchange({ grant_type: 'authorization_code', client_id: issued,
                code: callback.get('code')!, code_verifier: attempt.verifier, redirect_uri: attempt.callbackUri });
            stage = 'tokens.validate'; const tokens = validateTokens(response);
            stage = 'identity.verify'; const identity = await this.oidc.verify(tokens.idToken, issued, attempt.nonce);
            stage = 'account.validate';
            if (previous && previous.subject !== identity.subject) throw new Error('ChatGPT account does not match this provider');
            if (attempt.cancelled || this.closed) throw new Error('Sign-in cancelled');
            stage = 'credentials.save';
            await this.store.put({ providerId: id, clientId: issued, subject: identity.subject, email: identity.email, tokens });
            this.audit?.write({ event: 'provider.authorization.completed', durationMs: Date.now() - startedAt });
        } catch (error) { reportAuthorizationFailure(this.audit, stage, error, startedAt); throw error; }
    }
    private async finish(id: string, attempt: Attempt, issue?: string): Promise<void> {
        if (this.pending.get(id) !== attempt) return;
        this.pending.delete(id); clearTimeout(attempt.timer);
        // A callback response must finish before the listener is fully closed.
        attempt.server.close(); attempt.server.closeIdleConnections();
        this.issues.delete(id); if (issue) this.issues.set(id, issue); this.changed();
    }
    private changed(): void { for (const listener of this.listeners) listener(); }
    private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error('ChatGPT authorization host is closed'));
        const work = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
        this.operations.set(id, work);
        void work.finally(() => { if (this.operations.get(id) === work) this.operations.delete(id); }).catch(() => {});
        return work;
    }
}

function validateCallback(attempt: Attempt, raw: string): URLSearchParams {
    if (raw.length > 32_768) throw new Error('Invalid callback URL');
    const url = new URL(raw), expected = new URL(attempt.callbackUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password
        || url.searchParams.get('state') !== attempt.state) throw new Error('Invalid sign-in callback state');
    for (const key of ['code', 'state', 'error', 'client_id']) if (url.searchParams.getAll(key).length > 1) throw new Error('Duplicate callback field');
    if (!url.searchParams.get('code') && !url.searchParams.get('error')) throw new Error('Missing authorization result');
    return url.searchParams;
}
function validateTokens(response: OAuthTokens, previous?: NonNullable<Registration['tokens']>): NonNullable<Registration['tokens']> {
    const scopes = typeof response.scope === 'string' ? response.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (typeof response.access_token !== 'string' || !response.access_token || typeof response.refresh_token !== 'string' || !response.refresh_token
        || (response.id_token !== undefined && typeof response.id_token !== 'string') || !(response.id_token || previous?.idToken)
        || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86_400
        || !scopes || !['resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => scopes.includes(scope))) {
        throw new Error('ChatGPT plan permission or credentials missing');
    }
    return { accessToken: response.access_token, refreshToken: response.refresh_token,
        idToken: response.id_token || previous!.idToken, scopes, expiresAt: Date.now() + response.expires_in * 1000 };
}
function listen(server: Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
    });
}

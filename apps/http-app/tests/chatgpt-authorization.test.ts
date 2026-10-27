import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile, readdir, chmod } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrivateAuthStore } from '@itookit/node-host/authorization';
import { ChatGPTAuthorization } from '@itookit/node-host/authorization';
import { OpenAIOidc } from '@itookit/node-host/authorization';
import { acquireHostLock } from '@itookit/node-host/storage';
import type { AuditEvent } from '@itookit/node-host/logging';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' };
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
function jwt(nonce: string, changes: Record<string, unknown> = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'account',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce, email: 'user@example.com', ...changes })).toString('base64url');
    return header + '.' + payload + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + payload), keys.privateKey).toString('base64url');
}
async function setup() {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-chatgpt-'));
    releases.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PrivateAuthStore(directory); await store.initialize();
    const requests: Array<{ url: string; body: URLSearchParams }> = [];
    let nonce = '', grants = scopes, tokenIdentity: Record<string, unknown> = {}, refreshes = 0, failure = 0;
    let errorBody: unknown = { error: 'secret-provider-body' };
    const fetcher: typeof fetch = async (input, init) => {
        const url = String(input), body = new URLSearchParams(init?.body as URLSearchParams);
        requests.push({ url, body });
        if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com',
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
        if (url.endsWith('/jwks.json')) return Response.json({ keys: [publicKey] });
        if (url.endsWith('/revoke')) return new Response(null, { status: failure || 200 });
        if (failure) return Response.json(errorBody, { status: failure, headers: { 'x-request-id': 'req_test' } });
        if (body.get('grant_type') === 'refresh_token') refreshes++;
        return Response.json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`,
            id_token: jwt(nonce, tokenIdentity), scope: grants, expires_in: 3600 });
    };
    const auditEvents: AuditEvent[] = [];
    const oidc = new OpenAIOidc(fetcher), auth = new ChatGPTAuthorization(store, oidc, { write: event => auditEvents.push(event) });
    releases.push(() => auth.close());
    const begin = async () => {
        const state = await auth.begin('provider'); nonce = new URL(state.pending!.url).searchParams.get('nonce')!;
        const callback = new URL(state.pending!.callbackUri);
        callback.searchParams.set('state', new URL(state.pending!.url).searchParams.get('state')!);
        callback.searchParams.set('code', 'private-code'); callback.searchParams.set('client_id', 'oaiapp_test');
        return { state, callback };
    };
    return { directory, store, auth, oidc, requests, begin, auditEvents,
        changeIdentity: (value: Record<string, unknown>) => { tokenIdentity = value; },
        changeGrants: (value: string) => { grants = value; },
        fail: (status: number, body: unknown = { error: 'secret-provider-body' }) => { failure = status; errorBody = body; } };
}

it('completes PKCE authorization, keeps credentials private and restores the same host after restart', async () => {
    const fixture = await setup(), { auth, store, begin, requests, directory } = fixture;
    const { state, callback } = await begin(), url = new URL(state.pending!.url);
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('agent_name_hint')).toBe('NestOS');
    expect(url.searchParams.get('ext_agent_host_id')).toBe(store.hostId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await auth.complete('provider', state.pending!.id, callback.href)).status).toBe('authorized');
    expect(JSON.stringify(auth.state('provider'))).not.toMatch(/access-|refresh-|private-code|idToken/);
    expect(requests.find(item => item.body.get('grant_type') === 'authorization_code')!.body.get('client_id')).toBe('oaiapp_test');
    const renewed = await auth.credentials('provider').session.getToken({ rejectedAccessToken: 'access-0' });
    expect(renewed.accessToken).toBe('access-1');
    const restored = new PrivateAuthStore(directory); await restored.initialize();
    expect(restored.hostId).toBe(store.hostId); expect(restored.get('provider')!.tokens!.refreshToken).toBe('refresh-1');
    const file = (await readdir(directory)).find(name => /^[a-f0-9]{64}\.json$/.test(name))!;
    expect((await stat(path.join(directory, file))).mode & 0o077).toBe(0);
    expect(await readFile(path.join(directory, file), 'utf8')).not.toContain('code_verifier');
});

it('accepts a real loopback callback and reuses the issued client on later sign-in', async () => {
    const { auth, begin } = await setup(), { state, callback } = await begin();
    expect((await fetch(callback)).status).toBe(200);
    expect(auth.state('provider').status).toBe('authorized');
    await expect(auth.complete('provider', state.pending!.id, callback.href)).rejects.toThrow('expired');
    const returning = await begin(), url = new URL(returning.state.pending!.url);
    expect(url.searchParams.get('client_id')).toBe('oaiapp_test'); expect(url.searchParams.has('agent_name_hint')).toBe(false);
});

it('rejects state, redirect, duplicate fields and stale callbacks before exchanging a code', async () => {
    const { auth, begin, requests } = await setup(), { state, callback } = await begin();
    for (const invalid of [callback.href.replace('127.0.0.1', 'localhost'), callback.href + '&state=another', callback.href.replace(/state=[^&]+/, 'state=bad')]) {
        await expect(auth.complete('provider', state.pending!.id, invalid)).rejects.toThrow();
    }
    expect(requests.some(item => item.body.get('grant_type') === 'authorization_code')).toBe(false);
    await auth.cancel('provider');
    await expect(auth.complete('provider', state.pending!.id, callback.href)).rejects.toThrow('expired');
});

it.each([{ nonce: 'wrong' }, { aud: 'another-client' }, { iss: 'https://evil.example' },
    { exp: 1 }, { sub: 'different-account' }])('rejects invalid or mismatched identity without replacing active credentials: %s', async claims => {
    const { auth, begin, changeIdentity, store } = await setup();
    const first = await begin(); await auth.complete('provider', first.state.pending!.id, first.callback.href);
    const original = store.get('provider');
    const next = await begin(); changeIdentity(claims);
    const result = await auth.complete('provider', next.state.pending!.id, next.callback.href);
    expect(result.issue).toBe('authorization-failed'); expect(store.get('provider')).toEqual(original);
});

it('rejects missing plan grants, clears local tokens on sign-out and preserves registration identity', async () => {
    const { auth, begin, changeGrants, store, fail } = await setup();
    let attempt = await begin(); changeGrants('openid profile');
    expect((await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href)).issue).toBe('authorization-failed');
    expect(store.get('provider')).toBeUndefined(); changeGrants(scopes);
    attempt = await begin(); await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href);
    fail(503);
    expect(await auth.disconnect('provider')).toMatchObject({ status: 'signed-out', issue: 'revocation-unconfirmed' });
    expect(store.get('provider')).toMatchObject({ clientId: 'oaiapp_test', subject: 'account', tokens: undefined });
    await expect(auth.credentials('provider').session.getToken()).rejects.toThrow('reauthorization_required');
});

it('merges rotating refreshes and preserves renewable credentials on transient failures', async () => {
    const { auth, begin, store, requests, fail } = await setup(), attempt = await begin();
    await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href);
    const session = auth.credentials('provider').session;
    const results = await Promise.all(Array.from({ length: 5 }, () => session.getToken({ rejectedAccessToken: 'access-0' })));
    expect(results.every(item => item.accessToken === 'access-1')).toBe(true);
    expect(requests.filter(item => item.body.get('grant_type') === 'refresh_token')).toHaveLength(1);
    fail(503);
    await expect(session.getToken({ rejectedAccessToken: 'access-1' })).rejects.toThrow('refresh_unavailable');
    expect(auth.state('provider')).toMatchObject({ status: 'authorized', issue: 'refresh-unavailable' });
    expect(store.get('provider')!.tokens!.refreshToken).toBe('refresh-1');
});

it('rejects a forged signature and public credential directories', async () => {
    const { oidc, directory } = await setup(), signed = jwt('nonce');
    const pieces = signed.split('.'); pieces[1] = Buffer.from(JSON.stringify({ sub: 'forged' })).toString('base64url');
    await expect(oidc.verify(pieces.join('.'), 'oaiapp_test', 'nonce')).rejects.toThrow('signature');
    await chmod(directory, 0o755);
    await expect(new PrivateAuthStore(directory).initialize()).rejects.toThrow('private');
});

it('uses an OS-backed directory lock and permits reopening after release', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-http-lock-'));
    releases.push(() => rm(directory, { recursive: true, force: true }));
    const release = await acquireHostLock(directory);
    try { await expect(acquireHostLock(directory)).rejects.toThrow('another application host'); }
    finally { release(); }
    (await acquireHostLock(directory))();
});

it.each([
    [{ error: 'invalid_grant', error_description: 'private-provider-details' }, 'invalid_grant'],
    [{ error: { code: 'unsupported_country_region_territory', message: 'private-provider-details' } }, 'unsupported_country_region_territory'],
    [{ error: 'private-provider-details' }, 'http_error'],
])('records token exchange failures using only controlled provider codes: %j', async (body, code) => {
    const { auth, begin, fail, auditEvents, store } = await setup(), attempt = await begin(); fail(403, body);
    expect((await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href)).issue).toBe('authorization-failed');
    expect(auditEvents).toContainEqual({ event: 'provider.authorization.failed', operation: 'token.exchange',
        code, status: 403, providerRequestId: 'req_test', durationMs: expect.any(Number) });
    expect(JSON.stringify(auditEvents)).not.toMatch(/private-provider-details|private-code|code_verifier|refresh-|access-|nonce|state/);
    expect(store.get('provider')).toBeUndefined();
});

it('distinguishes credential, identity and storage failures without logging their values', async () => {
    const { auth, begin, auditEvents, changeGrants, changeIdentity, store } = await setup();
    let attempt = await begin(); changeGrants('openid profile');
    await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href);
    expect(auditEvents.at(-1)).toMatchObject({ operation: 'tokens.validate', code: 'TOKEN_RESPONSE_INVALID' });
    changeGrants(scopes); attempt = await begin(); changeIdentity({ nonce: 'private-invalid-nonce' });
    await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href);
    expect(auditEvents.at(-1)).toMatchObject({ operation: 'identity.verify', code: 'IDENTITY_NONCE_MISMATCH' });
    changeIdentity({}); attempt = await begin();
    const write = vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('private-storage-path'));
    try {
        await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href);
        expect(auditEvents.at(-1)).toMatchObject({ operation: 'credentials.save', code: 'CREDENTIAL_STORAGE_FAILED' });
    } finally { write.mockRestore(); }
    expect(JSON.stringify(auditEvents)).not.toMatch(/private-|user@example|access-|refresh-/);
    expect(store.get('provider')).toBeUndefined();
});

it('does not report successful reauthorization when the previous account remains active after failure', async () => {
    const { auth, begin, fail, auditEvents } = await setup();
    const first = await begin(); await auth.complete('provider', first.state.pending!.id, first.callback.href);
    expect(auditEvents.at(-1)).toMatchObject({ event: 'provider.authorization.completed' });
    const next = await begin(); fail(400);
    const response = await fetch(next.callback), body = await response.text();
    expect(response.status).toBe(200); expect(body).toContain('Sign-in did not complete');
    expect(body).toContain('provider.authorization.failed');
    expect(auth.state('provider')).toMatchObject({ status: 'authorized', issue: 'authorization-failed' });
    expect(body).not.toContain('secret-provider-body');
});

it('preserves network classifications and omits untrusted response identifiers', async () => {
    const oidc = new OpenAIOidc(async () => { throw new DOMException('private-network-address', 'TimeoutError'); });
    await expect(oidc.authorizeURL()).rejects.toMatchObject({ code: 'request_timeout' });
    const denied = new OpenAIOidc(async () => Response.json({ error: 'private-provider-body' },
        { status: 403, headers: { 'x-request-id': 'private-request-id?token=private' } }));
    await expect(denied.authorizeURL()).rejects.toMatchObject({ status: 403, code: 'http_error', requestId: undefined });
});

it.each([
    { aud: 'oaiapp_test' }, { aud: ['oaiapp_test'] }, { aud: ['oaiapp_test'], azp: 'oaiapp_test' },
    { aud: ['other-audience', 'oaiapp_test'], azp: 'oaiapp_test' },
])('accepts signed identity tokens with the registered client audience: %j', async claims => {
    const { auth, begin, changeIdentity, store } = await setup(), attempt = await begin(); changeIdentity(claims);
    expect((await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href)).status).toBe('authorized');
    expect(store.get('provider')?.tokens).toBeDefined();
});

it.each([
    [{ iss: 'https://private-issuer.example' }, 'IDENTITY_ISSUER_MISMATCH'],
    [{ aud: ['private-other-client'] }, 'IDENTITY_AUDIENCE_MISMATCH'],
    [{ aud: [] }, 'IDENTITY_AUDIENCE_MISMATCH'],
    [{ aud: ['oaiapp_test', 1], azp: 'oaiapp_test' }, 'IDENTITY_AUDIENCE_MISMATCH'],
    [{ aud: ['oaiapp_test', 'other'] }, 'IDENTITY_AUTHORIZED_PARTY_MISSING'],
    [{ azp: 'private-other-client' }, 'IDENTITY_AUTHORIZED_PARTY_MISMATCH'],
    [{ exp: undefined }, 'IDENTITY_EXPIRY_INVALID'],
    [{ exp: 1 }, 'IDENTITY_EXPIRED'],
    [{ sub: '' }, 'IDENTITY_SUBJECT_INVALID'],
    [{ iat: undefined }, 'IDENTITY_ISSUED_AT_INVALID'],
    [{ iat: Math.floor(Date.now() / 1000) + 3600 }, 'IDENTITY_ISSUED_IN_FUTURE'],
    [{ nbf: Math.floor(Date.now() / 1000) + 3600 }, 'IDENTITY_NOT_ACTIVE'],
    [{ nonce: undefined }, 'IDENTITY_NONCE_MISSING'],
    [{ nonce: 'private-wrong-nonce' }, 'IDENTITY_NONCE_MISMATCH'],
])('reports the exact rejected identity check without disclosing claim values: %j', async (claims, code) => {
    const { auth, begin, changeIdentity, auditEvents, store } = await setup(), attempt = await begin(); changeIdentity(claims);
    expect((await auth.complete('provider', attempt.state.pending!.id, attempt.callback.href)).issue).toBe('authorization-failed');
    expect(auditEvents.at(-1)).toMatchObject({ operation: 'identity.verify', code });
    expect(store.get('provider')).toBeUndefined();
    expect(JSON.stringify(auditEvents)).not.toMatch(/private-|user@example|oaiapp_test|access-|refresh-/);
});

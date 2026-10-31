import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import type {ToolConnectionType} from '@itookit/app-contracts/services';
import {NodeToolConnections} from '../src/runtime/tool-connections';

const type: ToolConnectionType = {id: 'fixture', name: 'Fixture', description: '', fields: [{name: 'clientId', label: 'Client', required: true},
    {name: 'secret', label: 'Secret', secret: true}, {name: 'refresh', label: 'Refresh', secret: true}], authorization: {
        kind: 'oauth2', authorizationEndpoint: 'https://auth.fixture.invalid/authorize', tokenEndpoint: 'https://auth.fixture.invalid/token',
        revocationEndpoint: 'https://auth.fixture.invalid/revoke', clientIdField: 'clientId', clientSecretField: 'secret', refreshTokenField: 'refresh',
        permissionGroups: [{id: 'a', label: 'A', scopes: ['read:a']}, {id: 'b', label: 'B', scopes: ['read:b']}],
    }};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers();});
async function setup(fetcher: typeof fetch) {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-oauth-')); cleanups.push(() => rm(root, {recursive: true, force: true}));
    const store = new NodeToolConnections(root, {redirectUri: 'https://nestos.fixture.invalid/api/tool-connections/callback', fetcher});
    store.register(type); cleanups.push(() => store.close());
    await store.save({id: 'personal', type: 'fixture', name: 'Personal', values: {clientId: 'client', secret: 'private-client-secret'}});
    return store;
}
it('authorizes permission groups once with PKCE and reuses a cached access token without exposing secrets', async () => {
    let verifier = '';
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = init.body as URLSearchParams; verifier = body.get('code_verifier')!;
        expect(body.get('grant_type')).toBe('authorization_code'); expect(init.redirect).toBe('error');
        return Response.json({access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'read:a read:b'});
    });
    const store = await setup(fetcher as typeof fetch), pending = await store.beginAuthorization('personal', ['a', 'b'], 'operation');
    expect(await store.beginAuthorization('personal', ['b', 'a'], 'operation')).toEqual(pending);
    const url = new URL(pending.url!); expect(url.searchParams.get('scope')).toBe('read:a read:b');
    await Promise.all([store.completeAuthorization({state: url.searchParams.get('state')!, code: 'private-code'}), store.completeAuthorization({state: url.searchParams.get('state')!, code: 'private-code'})]);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await store.authorizationStatus('operation')).status).toBe('authorized');
    expect(await store.accessToken('personal', 'fixture')).toBe('private-access'); expect(fetcher).toHaveBeenCalledTimes(1);
    const snapshot = JSON.stringify(await store.snapshot()); expect(snapshot).not.toMatch(/private-access|private-refresh|private-client-secret|private-code/);
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('private-refresh');
});
it('rejects another user’s state and refuses a cancelled or expired callback before exchange', async () => {
    const fetcher = vi.fn(async () => Response.json({access_token: 'access', refresh_token: 'refresh'}));
    const a = await setup(fetcher as typeof fetch), b = await setup(fetcher as typeof fetch);
    const pending = await a.beginAuthorization('personal', ['a'], 'operation'), state = new URL(pending.url!).searchParams.get('state')!;
    await expect(b.completeAuthorization({state, code: 'code'})).rejects.toThrow('TOOL_AUTH_STATE_INVALID');
    await a.cancelAuthorization('operation'); await expect(a.completeAuthorization({state, code: 'code'})).rejects.toThrow('TOOL_AUTH_CANCELLED');
    const second = await a.beginAuthorization('personal', ['a'], 'second');
    vi.spyOn(Date, 'now').mockReturnValue(second.expiresAt + 1);
    await expect(a.completeAuthorization({state: new URL(second.url!).searchParams.get('state')!, code: 'code'})).rejects.toThrow('TOOL_AUTH_EXPIRED');
    expect(fetcher).not.toHaveBeenCalled();
});
it('does not store an authorization result after cancellation or configuration replacement during exchange', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
    const store = await setup(fetcher as typeof fetch), pending = await store.beginAuthorization('personal', ['a'], 'operation');
    const result = store.completeAuthorization({state: new URL(pending.url!).searchParams.get('state')!, code: 'code'});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); await store.cancelAuthorization('operation');
    finish(Response.json({access_token: 'discard-access', refresh_token: 'discard-refresh'}));
    await expect(result).rejects.toThrow('TOOL_AUTH_CANCELLED'); expect((await store.resolve('personal', 'fixture')).refresh).toBe('');
});
it('refreshes in single flight, persists token rotation and preserves credentials on remote revocation failure', async () => {
    let revoke = false;
    const fetcher = vi.fn(async (url: unknown) => revoke ? new Response('', {status: 503}) : Response.json({access_token: 'access', refresh_token: 'rotated', expires_in: 3600}));
    const store = await setup(fetcher as typeof fetch);
    await store.save({id: 'personal', type: 'fixture', name: 'Personal', values: {clientId: 'client', secret: 'secret', refresh: 'initial'}});
    expect(await Promise.all([store.accessToken('personal', 'fixture'), store.accessToken('personal', 'fixture')])).toEqual(['access', 'access']);
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await store.resolve('personal', 'fixture')).refresh).toBe('rotated');
    revoke = true; await expect(store.revokeAuthorization('personal')).rejects.toThrow('TOOL_AUTH_REVOCATION_REJECTED');
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('rotated');
});
it.each([
    [{error: 'invalid_grant', error_description: 'private-provider-detail'}, 400, 'TOOL_AUTH_REAUTHORIZE_REQUIRED'],
    [{access_token: 'private-access', refresh_token: 'private-refresh', scope: 'read:b'}, 200, 'TOOL_AUTH_SCOPE_NOT_GRANTED'],
    [{access_token: 'private-access', refresh_token: 'private-refresh', scope: 42}, 200, 'TOOL_AUTH_TOKEN_INVALID'],
] as const)('classifies rejected exchanges without persisting or logging provider credentials (%s)', async (reply, status, code) => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const store = await setup(vi.fn(async () => Response.json(reply, {status})) as typeof fetch);
    const operation = await store.beginAuthorization('personal', ['a'], 'failed-operation');
    await expect(store.completeAuthorization({state: new URL(operation.url!).searchParams.get('state')!, code: 'private-code'})).rejects.toThrow(code);
    expect(await store.authorizationStatus(operation.operationId)).toMatchObject({status: 'failed', code});
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('');
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private-provider-detail|private-access|private-refresh|private-code|private-client-secret/);
});
it('refuses replaced credentials during exchange and clears credentials only after successful revocation', async () => {
    let finish!: (response: Response) => void;
    const store = await setup(vi.fn(() => new Promise<Response>(resolve => {finish = resolve;})) as typeof fetch);
    const pending = await store.beginAuthorization('personal', ['a'], 'operation');
    const result = store.completeAuthorization({state: new URL(pending.url!).searchParams.get('state')!, code: 'code'});
    await store.save({id: 'personal', type: 'fixture', name: 'Updated', values: {clientId: 'new-client', secret: 'new-secret'}});
    finish(Response.json({access_token: 'discard', refresh_token: 'discard'}));
    await expect(result).rejects.toThrow('TOOL_AUTH_CANCELLED');
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('');
    const revoked = await setup(vi.fn(async () => new Response('', {status: 200})) as typeof fetch);
    await revoked.save({id: 'personal', type: 'fixture', name: 'Personal', values: {clientId: 'client', refresh: 'initial'}});
    await revoked.revokeAuthorization('personal');
    expect((await revoked.resolve('personal', 'fixture')).refresh).toBe('');
    expect((await revoked.snapshot()).connections[0].authorization?.connected).toBe(false);
});

it('verifies imported credentials with a fresh token request and persists a redacted result across reopen', async () => {
    let fail = false;
    const fetcher = vi.fn(async () => fail ? Response.json({error: 'invalid_grant', error_description: 'PRIVATE_RESPONSE'}, {status: 400})
        : Response.json({access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_ROTATED_REFRESH', expires_in: 3600}));
    const root = await mkdtemp(path.join(tmpdir(), 'tool-verify-')); cleanups.push(() => rm(root, {recursive: true, force: true}));
    const store = new NodeToolConnections(root, {fetcher}); store.register(type); cleanups.push(() => store.close());
    await store.save({id: 'personal', type: 'fixture', name: 'Personal', values: {clientId: 'client', secret: 'PRIVATE_SECRET', refresh: 'PRIVATE_REFRESH'}});
    expect((await store.snapshot()).connections[0].verification).toBeUndefined();
    expect(await store.verify('personal')).toMatchObject({status: 'verified', checkedAt: expect.any(Number)});
    const snapshot = await store.snapshot(); expect(snapshot.connections[0].verification?.status).toBe('verified');
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_ACCESS|PRIVATE_REFRESH|PRIVATE_SECRET|PRIVATE_ROTATED_REFRESH/);
    const reopened = new NodeToolConnections(root, {fetcher}); reopened.register(type); cleanups.push(() => reopened.close());
    expect((await reopened.snapshot()).connections[0].verification?.status).toBe('verified');
    fail = true;
    expect(await store.verify('personal')).toMatchObject({status: 'failed', code: 'TOOL_AUTH_REAUTHORIZE_REQUIRED'});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await store.snapshot()).connections[0].verification).toMatchObject({status: 'failed', code: 'TOOL_AUTH_REAUTHORIZE_REQUIRED'});
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('PRIVATE_ROTATED_REFRESH');
    await store.save({id: 'personal', type: 'fixture', name: 'Updated', values: {clientId: 'client', secret: ''}});
    expect((await store.snapshot()).connections[0].verification).toBeUndefined();
});

it('refreshes saved OAuth credentials after a host restart and updated display metadata without a consent flow', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-upgrade-auth-')); cleanups.push(() => rm(root, {recursive: true, force: true}));
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = init!.body as URLSearchParams;
        expect(body.get('grant_type')).toBe('refresh_token'); expect(body.get('refresh_token')).toBe('PRIVATE_SAVED_REFRESH');
        return Response.json({access_token: 'PRIVATE_NEW_ACCESS', expires_in: 3600});
    });
    const first = new NodeToolConnections(root, {fetcher}); first.register(type);
    await first.save({id: 'personal', type: type.id, name: 'Personal', values: {clientId: 'client', secret: 'PRIVATE_SECRET', refresh: 'PRIVATE_SAVED_REFRESH'}});
    await first.close();
    const upgraded = new NodeToolConnections(root, {fetcher}); cleanups.push(() => upgraded.close());
    upgraded.register({...type, name: 'Updated package display name'});
    expect(await upgraded.accessToken('personal', type.id)).toBe('PRIVATE_NEW_ACCESS');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await upgraded.snapshot())).not.toContain('PRIVATE_');
});

it('reports host network failure as verification failure without deleting saved credentials', async () => {
    const fetcher = vi.fn(async () => {throw new Error('PRIVATE_PROXY_URL');});
    const store = await setup(fetcher as typeof fetch);
    await store.save({id: 'personal', type: 'fixture', name: 'Personal', values: {clientId: 'client', secret: '', refresh: 'PRIVATE_REFRESH'}});
    expect(await store.verify('personal')).toMatchObject({status: 'failed', code: 'TOOL_AUTH_TRANSPORT_FAILED'});
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('PRIVATE_REFRESH');
    expect(JSON.stringify((await store.snapshot()).connections[0].verification)).not.toContain('PRIVATE_');
});

it('does not attach verification to credentials replaced while the token request was pending', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
    const store = await setup(fetcher as typeof fetch);
    await store.save({id: 'personal', type: 'fixture', name: 'Personal', values: {clientId: 'client', secret: '', refresh: 'first'}});
    const checking = store.verify('personal');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await store.save({id: 'personal', type: 'fixture', name: 'Changed', values: {clientId: 'other-client', secret: '', refresh: 'replacement'}});
    finish(Response.json({access_token: 'PRIVATE_OLD_ACCESS', expires_in: 3600}));
    await expect(checking).rejects.toThrow('TOOL_AUTH_CONNECTION_CHANGED');
    expect((await store.snapshot()).connections[0].verification).toBeUndefined();
    expect((await store.resolve('personal', 'fixture')).refresh).toBe('replacement');
});

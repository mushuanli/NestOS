import {chmod, lstat, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, expect, it, vi} from 'vitest';
import type {ToolConnectionType} from '@itookit/app-contracts/services';
import {NodeToolConnections} from '../src/runtime/tool-connections';
import {ToolOAuthApplications} from '../src/runtime/tool-oauth-applications';
import {RpcPeer} from '@itookit/app-transport/application';

const type: ToolConnectionType = {id: 'fixture', name: 'Fixture', description: '', fields: [
    {name: 'client', label: 'Client', required: true}, {name: 'secret', label: 'Secret', secret: true, required: true},
    {name: 'refresh', label: 'Refresh', secret: true}, {name: 'directory', label: 'Directory'}], authorization: {
    kind: 'oauth2', authorizationEndpoint: 'https://fixture.invalid/authorize', tokenEndpoint: 'https://fixture.invalid/token',
    clientIdField: 'client', clientSecretField: 'secret', refreshTokenField: 'refresh', permissionGroups: [{id: 'read', label: 'Read', scopes: ['read:a']}],
}};
const input = {type: 'fixture', clientId: 'shared-client', clientSecret: 'private-application-secret', redirectUri: 'https://nestos.fixture.invalid/api/tool-connections/callback'};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture(fetcher: typeof fetch = vi.fn(async () => Response.json({access_token: 'access', refresh_token: 'refresh', expires_in: 3600}))) {
    const root = await mkdtemp(path.join(tmpdir(), 'oauth-applications-')); cleanups.push(() => rm(root, {recursive: true, force: true}));
    const applications = new ToolOAuthApplications(path.join(root, 'private-apps'));
    const user = (id: string, admin = false) => {
        const store = new NodeToolConnections(path.join(root, id), {applications, manageApplications: admin, fetcher}); store.register(type);
        cleanups.push(() => store.close()); return store;
    };
    return {root, applications, user, admin: user('admin', true)};
}
async function connect(store: NodeToolConnections, operationId: string) {
    await store.save({id: 'personal', type: type.id, name: 'Personal', values: {directory: 'imports'}});
    const pending = await store.beginAuthorization('personal', ['read'], operationId);
    await store.completeAuthorization({state: new URL(pending.url!).searchParams.get('state')!, code: operationId}); return pending;
}
it('configures one application for independent users without copying application secrets into tokens, tools or public metadata', async () => {
    const fetcher = vi.fn(async (_url, request) => {
        const body = request!.body as URLSearchParams;
        expect(body.get('client_secret')).toBe(input.clientSecret); expect(body.get('redirect_uri')).toBe(input.redirectUri);
        return Response.json({access_token: 'access-' + body.get('code'), refresh_token: 'refresh-' + body.get('code'), expires_in: 3600});
    }) as typeof fetch;
    const f = await fixture(fetcher); await f.admin.saveApplication(input);
    const alice = f.user('alice'), bob = f.user('bob');
    const pending = await connect(alice, 'alice-operation');
    await expect(bob.completeAuthorization({state: new URL(pending.url!).searchParams.get('state')!, code: 'alice-operation'})).rejects.toThrow('TOOL_AUTH_STATE_INVALID');
    await connect(bob, 'bob-operation');
    expect(await alice.accessToken('personal', 'fixture')).toBe('access-alice-operation');
    expect(await bob.accessToken('personal', 'fixture')).toBe('access-bob-operation');
    await alice.save({id: 'personal', type: 'fixture', name: 'Renamed', values: {directory: 'another-directory'}});
    expect((await alice.snapshot()).connections[0].authorization?.scopes).toEqual(['read:a']);
    expect(await alice.resolve('personal', 'fixture')).not.toHaveProperty('secret');
    for (const store of [f.admin, alice, bob]) expect(JSON.stringify(await store.snapshot())).not.toContain(input.clientSecret);
    expect((await alice.snapshot()).types[0].application).toEqual({configured: true, canManage: false, redirectUri: input.redirectUri});
    const disk = await readFile(path.join(f.root, 'alice', 'connections.json'), 'utf8');
    expect(disk).not.toContain(input.clientSecret); expect(disk).not.toContain(input.clientId); expect(disk).not.toContain('refresh-bob-operation');
    const info = await lstat(path.join(f.root, 'private-apps', 'applications.json')); expect(info.mode & 0o777).toBe(0o600);
    expect((await new ToolOAuthApplications(path.join(f.root, 'private-apps')).get('fixture'))?.clientSecret).toBe(input.clientSecret);
});
it('rejects application administration over RPC for an ordinary user and never exposes host-only token operations', async () => {
    const f = await fixture(), alice = f.user('alice'); let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), () => {});
    server = new RpcPeer('server', call => client.handle(call), () => {});
    cleanups.push(() => client.close(), () => server.close());
    const port = client.decode(await server.expose(alice));
    await expect(port.saveApplication(input)).rejects.toThrow('TOOL_AUTH_APPLICATION_ADMIN_REQUIRED');
    await expect(port.removeApplication('fixture')).rejects.toThrow('TOOL_AUTH_APPLICATION_ADMIN_REQUIRED');
    expect(port.accessToken).toBeUndefined(); expect(port.resolve).toBeUndefined(); expect(port.completeAuthorization).toBeUndefined();
    expect(await f.applications.get('fixture')).toBeUndefined();
});
it('invalidates cached and persisted grants after application rotation, preserves secrets on blank edits and supports reauthorization', async () => {
    const fetcher = vi.fn(async () => Response.json({access_token: 'access', refresh_token: 'refresh', expires_in: 3600}));
    const f = await fixture(fetcher as typeof fetch); await f.admin.saveApplication(input); const alice = f.user('alice');
    await connect(alice, 'first'); const original = await f.applications.get('fixture');
    await f.admin.saveApplication({...input, clientSecret: ''}); expect((await f.applications.get('fixture'))?.revision).toBe(original?.revision);
    await f.admin.saveApplication({...input, clientId: 'replacement-client', clientSecret: ''});
    expect((await f.applications.get('fixture'))?.clientSecret).toBe(input.clientSecret);
    await expect(alice.accessToken('personal', 'fixture')).rejects.toThrow('TOOL_AUTH_REAUTHORIZE_REQUIRED'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await alice.snapshot()).connections[0].authorization?.connected).toBe(false);
    await connect(alice, 'second'); expect(await alice.accessToken('personal', 'fixture')).toBe('access');
    await f.admin.removeApplication('fixture');
    await expect(alice.accessToken('personal', 'fixture')).rejects.toThrow('TOOL_AUTH_APPLICATION_UNCONFIGURED'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects an exchange against an application changed while its token request was in flight', async () => {
    let finish!: (reply: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
    const f = await fixture(fetcher as typeof fetch); await f.admin.saveApplication(input); const alice = f.user('alice');
    await alice.save({id: 'personal', type: type.id, name: 'Personal', values: {}});
    const pending = await alice.beginAuthorization('personal', ['read'], 'pending');
    const result = alice.completeAuthorization({state: new URL(pending.url!).searchParams.get('state')!, code: 'code'});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); await f.admin.saveApplication({...input, clientId: 'replacement'});
    finish(Response.json({access_token: 'discard-access', refresh_token: 'discard-refresh'}));
    await expect(result).rejects.toThrow('TOOL_AUTH_CONNECTION_CHANGED');
    expect(await readFile(path.join(f.root, 'alice', 'connections.json'), 'utf8')).not.toContain('discard-refresh');
});
it('keeps a personal legacy client working and refuses both managed-field overrides and insecure application storage', async () => {
    const f = await fixture(); await f.admin.saveApplication(input); const alice = f.user('alice');
    await alice.save({id: 'legacy', type: 'fixture', name: 'Legacy', values: {client: 'own-client', secret: 'own-secret', refresh: 'own-refresh'}});
    expect((await alice.snapshot()).connections[0].authorization?.clientMode).toBe('personal');
    expect((await alice.resolve('legacy', 'fixture')).secret).toBe('own-secret');
    await alice.save({id: 'personal', type: 'fixture', name: 'Managed', values: {}});
    await expect(alice.save({id: 'personal', type: 'fixture', name: 'Override', values: {client: 'different'}})).rejects.toThrow('TOOL_AUTH_APPLICATION_FIELD_MANAGED');
    await expect(f.admin.saveApplication({...input, redirectUri: 'http://unsafe.invalid/callback'})).rejects.toThrow('TOOL_AUTH_REDIRECT_INVALID');
    await chmod(path.join(f.root, 'private-apps', 'applications.json'), 0o644);
    await expect(f.applications.get('fixture')).rejects.toThrow('TOOL_AUTH_APPLICATION_STORAGE_NOT_PRIVATE');
});

it('exposes redacted verification over RPC and invalidates it when the shared application changes', async () => {
    const fetcher = vi.fn(async () => Response.json({access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600}));
    const f = await fixture(fetcher as typeof fetch); await f.admin.saveApplication(input); const alice = f.user('alice');
    await connect(alice, 'first'); let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), () => {});
    server = new RpcPeer('server', call => client.handle(call), () => {}); cleanups.push(() => client.close(), () => server.close());
    const port = client.decode(await server.expose(alice));
    expect(await port.verify('personal')).toMatchObject({status: 'verified', checkedAt: expect.any(Number)});
    const snapshot = await port.snapshot(); expect(snapshot.connections[0].verification?.status).toBe('verified');
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_ACCESS|PRIVATE_REFRESH|private-application-secret/);
    expect(port.accessToken).toBeUndefined(); expect(port.resolve).toBeUndefined();
    await f.admin.saveApplication({...input, clientId: 'replacement-client'});
    expect((await port.snapshot()).connections[0].verification).toBeUndefined();
});

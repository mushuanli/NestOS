import {expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, cp} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCertificates, createUserCertificate, loadCertificates, startHost} from '@itookit/node-host/http';
import {HttpViewClient} from '@itookit/app-transport/http';
import type {ToolConnections} from '@itookit/app-contracts/services';
import {authenticatedFetch} from './tls-fixture';

it('shares administrator application setup over mTLS while isolating user tokens, callbacks and management privileges', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'http-oauth-applications-'));
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    const clients: HttpViewClient[] = [], auth: Array<Awaited<ReturnType<typeof authenticatedFetch>>> = [];
    try {
        const certs = path.join(root, 'certs'), ui = path.join(root, 'ui'), module = path.join(root, 'fixture.mjs');
        await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<title>OAuth fixture</title>');
        await writeFile(module, `export function createTools(api) {
            api.connections.register({id:'fixture', name:'Fixture', description:'', fields:[
                {name:'client',label:'Client',required:true},{name:'secret',label:'Secret',secret:true,required:true},{name:'refresh',label:'Refresh',secret:true}],
                authorization:{kind:'oauth2',authorizationEndpoint:'https://fixture.invalid/authorize',tokenEndpoint:'https://fixture.invalid/token',
                    clientIdField:'client',clientSecretField:'secret',refreshTokenField:'refresh',permissionGroups:[{id:'read',label:'Read',scopes:['read:a']}]}});
            return [];
        }`);
        vi.stubEnv('NESTOS_TOOL_MODULES', JSON.stringify([module])); vi.stubEnv('NESTOS_TOOL_PACKAGE_DIRS', '[]');
        await createCertificates(certs, ['127.0.0.1']); const issued = await createUserCertificate(certs, 'alice');
        const aliceCerts = path.dirname(issued.bundleFile);
        await cp(path.join(certs, 'ca.crt'), path.join(aliceCerts, 'ca.crt'));
        const adminFingerprint = new X509Certificate(await readFile(path.join(certs, 'client.crt'))).fingerprint256.replaceAll(':', '').toLowerCase();
        await writeFile(path.join(certs, 'clients.json'), JSON.stringify({[adminFingerprint]: {userId: 'admin'}, [issued.fingerprint]: {userId: 'alice'}}));
        const a = await authenticatedFetch(certs), b = await authenticatedFetch(aliceCerts); auth.push(a, b);
        host = await startHost({root: path.join(root, 'server'), sidecar: path.join(root, 'meta'), authDir: path.join(root, 'private'),
            usersDir: path.join(root, 'home'), staticDir: ui, auditFile: path.join(root, 'audit.jsonl'), certificates: await loadCertificates(certs), port: 0, host: '127.0.0.1', backlog: 32});
        const origin = `https://127.0.0.1:${(host.server.address() as {port: number}).port}`;
        const ports: ToolConnections[] = [];
        for (const identity of [a, b]) {
            const client = new HttpViewClient('same-view', origin + '/api/application', identity.fetcher); clients.push(client);
            ports.push((await (await client.start()).backend.toolboxView()).resources.toolPackages!.connections!);
        }
        const input = {type: 'fixture', clientId: 'host-client', clientSecret: 'PRIVATE_APP_SECRET', redirectUri: origin + '/api/tool-connections/callback'};
        await ports[0].saveApplication!(input);
        const snapshot = await ports[1].snapshot(); expect(snapshot.types.find(type => type.id === 'fixture')!.application).toEqual({configured: true, canManage: false, redirectUri: input.redirectUri});
        await expect(ports[1].saveApplication!(input)).rejects.toThrow('TOOL_AUTH_APPLICATION_ADMIN_REQUIRED');
        await ports[1].save({id: 'personal', name: 'Personal', type: 'fixture', values: {}});
        const pending = await ports[1].beginAuthorization!('personal', ['read'], 'alice-authorization');
        const state = new URL(pending.url!).searchParams.get('state');
        const wrongUser = await a.fetcher(origin + '/api/tool-connections/callback?state=' + state + '&code=PRIVATE_CALLBACK_CODE', {redirect: 'manual'});
        expect(wrongUser.status).toBe(303); expect(wrongUser.headers.get('X-VFS-Error')).toBe('TOOL_AUTH_STATE_INVALID');
        expect((await ports[1].authorizationStatus!('alice-authorization')).status).toBe('pending');
        expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_APP_SECRET');
        const audit = await readFile(path.join(root, 'audit.jsonl'), 'utf8'); expect(audit).not.toMatch(/PRIVATE_APP_SECRET|PRIVATE_CALLBACK_CODE/);
        expect(await readFile(path.join(root, 'home', 'alice', '.nestos', 'private', 'tool-connections', 'connections.json'), 'utf8')).not.toContain('PRIVATE_APP_SECRET');
    } finally {
        await Promise.all(clients.map(client => client.close())); auth.forEach(identity => identity.close()); await host?.close(); vi.unstubAllEnvs(); await rm(root, {recursive: true, force: true});
    }
}, 30000);

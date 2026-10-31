import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readDesktopClient, parseOptions, clientPath, promptOptions, prepareOptions, CLIENTS_URL} from '../node/authorize-input.mjs';
import {authorizeGoogle} from '../node/authorize.mjs';
const credentials = {client_id: 'test-client', client_secret: 'PRIVATE_CLIENT_SECRET'};
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'google-auth-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const client = path.join(root, 'downloaded client.json'); await writeFile(client, JSON.stringify({installed: credentials}));
    return {root, client, output: path.join(root, 'connection.json')};
}
test('distinguishes missing files, directories, invalid JSON, wrong client type and missing identity without exposing contents', async t => {
    const f = await fixture(t);
    await assert.rejects(readDesktopClient(path.join(f.root, 'missing')), {code: 'GOOGLE_CLIENT_FILE_NOT_FOUND'});
    await assert.rejects(readDesktopClient(f.root), {code: 'GOOGLE_CLIENT_NOT_FILE'});
    for (const [content, code] of [['{"client_secret":"PRIVATE_BROKEN', 'GOOGLE_CLIENT_JSON_INVALID'], [JSON.stringify({web: credentials}), 'GOOGLE_CLIENT_TYPE_INVALID'], ['{}', 'GOOGLE_CLIENT_FIELDS_MISSING'], ['x'.repeat(65537), 'GOOGLE_CLIENT_FILE_TOO_LARGE']]) {
        await writeFile(f.client, content);
        await assert.rejects(readDesktopClient(f.client), error => error.code === code && !error.message.includes('PRIVATE'));
    }
    await assert.rejects(readDesktopClient(f.client, {stat: async () => {throw Object.assign(new Error('PRIVATE_PATH'), {code: 'EACCES'});}}), {code: 'GOOGLE_CLIENT_FILE_UNREADABLE'});
});
test('accepts downloaded desktop JSON and pasted quoted paths with spaces', async t => {
    const f = await fixture(t); await writeFile(f.client, '\ufeff' + JSON.stringify({installed: credentials}));
    assert.equal(clientPath('"' + f.client + '"'), f.client);
    assert.equal(clientPath(f.client.replaceAll(' ', '\\ ')), f.client);
    assert.deepEqual(await readDesktopClient(f.client), credentials);
});
test('the wizard links Google setup, retries invalid paths, defaults to both services and never echoes credentials', async t => {
    const f = await fixture(t), messages = [], answers = [path.join(f.root, 'missing'), f.client, ''];
    const result = await promptOptions({}, async () => answers.shift(), text => messages.push(text));
    assert.equal(result.services, 'gmail,calendar'); assert.deepEqual(result.config, credentials);
    assert.ok(messages.some(text => text.includes(CLIENTS_URL))); assert.ok(messages.some(text => text.includes('同一台电脑')));
    assert.ok(messages.some(text => text.includes('找不到'))); assert.ok(!messages.join('').includes(credentials.client_secret));
    await assert.rejects(promptOptions({}, async () => {throw new Error('closed');}, () => {}), /closed/);
});
test('preflights explicit options and refuses existing output before starting authorization', async t => {
    const f = await fixture(t);
    assert.equal(parseOptions(['--help']).help, true);
    assert.throws(() => parseOptions(['--client']), {code: 'GOOGLE_ARGUMENT_INVALID'});
    assert.throws(() => parseOptions(['--services', 'drive']), {code: 'GOOGLE_SERVICES_INVALID'});
    const result = await prepareOptions(['--client', f.client, '--output', f.output], {isTTY: false});
    assert.equal(result.services, 'gmail,calendar'); assert.equal(result.output, f.output);
    await writeFile(f.output, 'existing');
    await assert.rejects(prepareOptions(['--client', f.client, '--output', f.output], {isTTY: false}), {code: 'GOOGLE_OUTPUT_EXISTS'});
    assert.equal(await readFile(f.output, 'utf8'), 'existing');
});
test('authorizes on a local callback, verifies state and PKCE, and saves an importable private file', async t => {
    const f = await fixture(t); let authorization; const stages = [];
    const fetcher = async (url, init) => {
        assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init.redirect, 'error');
        assert.equal(init.body.get('code'), 'received-code'); assert.equal(init.body.get('client_secret'), credentials.client_secret);
        assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        return Response.json({refresh_token: 'PRIVATE_REFRESH'});
    };
    await authorizeGoogle({...f, config: credentials, services: 'gmail,calendar'}, {fetcher, onStage: stage => stages.push(stage), showUrl: async value => {
        authorization = new URL(value); const callback = new URL(authorization.searchParams.get('redirect_uri'));
        assert.equal(callback.hostname, '127.0.0.1'); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        callback.search = new URLSearchParams({state: 'wrong', code: 'bad-code'}).toString();
        assert.equal((await fetch(callback)).status, 400);
        callback.search = new URLSearchParams({state: authorization.searchParams.get('state'), code: 'received-code'}).toString();
        assert.equal((await fetch(callback)).status, 200);
    }});
    assert.deepEqual(JSON.parse(await readFile(f.output, 'utf8')), {clientId: credentials.client_id, clientSecret: credentials.client_secret, refreshToken: 'PRIVATE_REFRESH'});
    assert.equal((await stat(f.output)).mode & 0o777, 0o600);
    assert.deepEqual(stages, ['callback-listen', 'callback-wait', 'token-exchange', 'output-write']);
});
test('denial and timeout release the callback listener without writing credentials', async t => {
    const f = await fixture(t); let callback;
    await assert.rejects(authorizeGoogle({...f, config: credentials, services: 'gmail'}, {fetcher: () => {throw new Error('must not exchange');}, showUrl: async value => {
        const url = new URL(value); callback = new URL(url.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({state: url.searchParams.get('state'), error: 'access_denied'}).toString(); await fetch(callback);
    }}), {code: 'GOOGLE_AUTH_DECLINED'});
    await assert.rejects(stat(f.output), {code: 'ENOENT'});
    await assert.rejects(fetch(callback));
    await assert.rejects(authorizeGoogle({...f, config: credentials, services: 'calendar'}, {showUrl: () => {}, timeoutMs: 10}), {code: 'GOOGLE_AUTH_TIMEOUT'});
});
test('the command reports missing files without stack traces or credential contents', async t => {
    const f = await fixture(t), script = new URL('../node/authorize.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [script.pathname, '--client', path.join(f.root, 'missing')], {encoding: 'utf8'});
    assert.equal(result.status, 1); assert.match(result.stderr, /GOOGLE_CLIENT_FILE_NOT_FOUND/);
    assert.match(result.stderr, /只是示例文件名/); assert.ok(!result.stderr.includes('at file:')); assert.equal(result.stdout, '');
});

test('uses configured environment proxies only inside the helper and respects an explicit opt-out', async () => {
    const {configureAuthorizationNetwork} = await import('../node/authorize-network.mjs');
    const calls = [], restore = () => calls.push('restored'), configure = env => {calls.push(env); return restore;};
    const env = {https_proxy: 'http://user:PRIVATE@127.0.0.1:1234', no_proxy: 'localhost'};
    configureAuthorizationNetwork(env, configure)(); assert.deepEqual(calls, [env, 'restored']);
    calls.length = 0;
    configureAuthorizationNetwork({...env, NODE_USE_ENV_PROXY: '0'}, configure)();
    configureAuthorizationNetwork({}, configure)(); assert.deepEqual(calls, []);
    assert.throws(() => configureAuthorizationNetwork(env, null, []), {code: 'GOOGLE_PROXY_RUNTIME_REQUIRED'});
    configureAuthorizationNetwork({...env, NODE_USE_ENV_PROXY: '1'}, null, [])();
    assert.throws(() => configureAuthorizationNetwork(env, () => {throw new Error('PRIVATE');}), error => error.code === 'GOOGLE_PROXY_CONFIGURATION_INVALID' && !error.message.includes('PRIVATE'));
});
test('routes native fetch through the helper environment proxy', async t => {
    const http = await import('node:http');
    if (!http.setGlobalProxyFromEnv) return t.skip('Runtime lacks dynamic environment proxy support');
    const {configureAuthorizationNetwork} = await import('../node/authorize-network.mjs');
    const proxy = http.createServer(); const targets = [];
    proxy.on('connect', (request, socket) => {targets.push(request.url); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const restore = configureAuthorizationNetwork({https_proxy: 'http://127.0.0.1:' + proxy.address().port});
    try {
        await assert.rejects(fetch('https://oauth-proxy-fixture.invalid/token', {signal: AbortSignal.timeout(2000)}));
        assert.deepEqual(targets, ['oauth-proxy-fixture.invalid:443']);
    } finally {restore(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));}
});
test('classifies network failures without preserving sensitive exception content', async () => {
    const {jsonRequest} = await import('../node/client.mjs');
    const {authorizationErrorMessage} = await import('../node/authorize-network.mjs');
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'PRIVATE_SECRET']) {
        const cause = Object.assign(new Error('PRIVATE_PROXY_URL'), {code});
        await assert.rejects(jsonRequest(async () => {throw new TypeError('PRIVATE_TOKEN', {cause});}, 'https://fixture.invalid', {}, 'AUTH'), error => {
            assert.equal(error.code, 'GOOGLE_AUTH_NETWORK');
            assert.equal(error.networkCode, code === 'PRIVATE_SECRET' ? 'UNKNOWN' : code);
            assert.ok(!JSON.stringify(error).includes('PRIVATE')); assert.ok(!authorizationErrorMessage(error).includes('PRIVATE'));
            assert.match(authorizationErrorMessage(error), /oauth2.googleapis.com/); return true;
        });
    }
    const controller = new AbortController(); controller.abort(new DOMException('timeout', 'TimeoutError'));
    await assert.rejects(jsonRequest(async () => {throw controller.signal.reason;}, 'https://fixture.invalid', {signal: controller.signal}, 'AUTH'), {code: 'GOOGLE_CANCELLED', networkCode: 'TIMEOUT'});
});
test('a successful browser callback followed by a failed token exchange does not save credentials', async t => {
    const f = await fixture(t);
    await assert.rejects(authorizeGoogle({...f, config: credentials, services: 'gmail'}, {
        fetcher: async () => {throw new TypeError('PRIVATE', {cause: Object.assign(new Error('PRIVATE'), {code: 'ECONNREFUSED'})});},
        showUrl: async value => {
            const url = new URL(value), callback = new URL(url.searchParams.get('redirect_uri'));
            callback.search = new URLSearchParams({state: url.searchParams.get('state'), code: 'received-code'}).toString();
            assert.equal((await fetch(callback)).status, 200);
        },
    }), {code: 'GOOGLE_AUTH_NETWORK', networkCode: 'ECONNREFUSED'});
    await assert.rejects(stat(f.output), {code: 'ENOENT'});
});

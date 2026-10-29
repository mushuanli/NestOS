import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectGoogle} from '../node/collect.mjs';
import {mailMaterial} from '../node/materials.mjs';

const message = id => ({id, payload: {mimeType: 'text/plain', headers: [{name: 'Subject', value: 'Private subject'}],
    body: {data: Buffer.from('I prefer TypeScript.').toString('base64url')}}});
function fixture(handler) {
    const files = new Map(), logs = [], calls = [];
    const context = {operationId: 'operation', vfs: {
        readFile: async file => {if (!files.has(file)) throw Object.assign(new Error('missing'), {code: 'ENOENT'}); return files.get(file);},
        writeFile: async (file, body) => {files.set(file, body);}}, onProgress: async progress => logs.push(progress.message)};
    const connections = {resolve: async (id, type) => {
        assert.equal(id, 'personal'); assert.equal(type, 'google-workspace');
        return {clientId: 'client', clientSecret: 'private-secret', refreshToken: 'private-refresh'};
    }};
    const fetcher = async (url, init) => {
        calls.push(String(url));
        assert.equal(init.redirect, 'error');
        if (String(url).includes('oauth2')) return Response.json({access_token: 'private-access'});
        assert.equal(init.headers.Authorization, 'Bearer private-access');
        return handler(new URL(url));
    };
    return {files, logs, calls, context, connections, fetcher};
}
const args = {connection: 'personal', directory: 'evidence/google', query: 'newer_than:30d', maxItems: 10};
test('paginates Gmail, stores stable evidence, reconciles removed messages and keeps diagnostics private', async () => {
    let removed = false;
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json(removed ? {} : url.searchParams.has('pageToken')
        ? {messages: [{id: 'b'}]} : {messages: [{id: 'a'}], nextPageToken: 'next'}) : Response.json(message(url.pathname.split('/').at(-1))));
    const first = await collectGoogle('gmail', args, f.context, f.connections, f.fetcher);
    assert.equal(first.count, 2); assert.equal(first.complete, true);
    const before = [...f.files.entries()];
    await collectGoogle('gmail', args, f.context, f.connections, f.fetcher); assert.deepEqual([...f.files.entries()], before);
    removed = true;
    const next = await collectGoogle('gmail', args, f.context, f.connections, f.fetcher);
    assert.equal(next.removed, 2); assert.ok([...f.files.values()].every(body => !body.includes('I prefer')));
    assert.doesNotMatch(f.logs.join(''), /private-|TypeScript|Private subject|newer_than/);
});
test('refuses incomplete results and permission failures before writing or invalidating existing evidence', async () => {
    const f = fixture(() => Response.json({messages: [{id: 'a'}, {id: 'b'}]}));
    await assert.rejects(collectGoogle('gmail', {...args, maxItems: 1}, f.context, f.connections, f.fetcher), /GOOGLE_COLLECTION_LIMIT_REFINE_RANGE/);
    assert.equal(f.files.size, 0);
    const denied = fixture(() => new Response('private upstream body', {status: 403}));
    await assert.rejects(collectGoogle('gmail', args, denied.context, denied.connections, denied.fetcher), /GOOGLE_MAIL_LIST_PERMISSION_DENIED/);
    assert.equal(denied.files.size, 0); assert.doesNotMatch(denied.logs.join(''), /private/);
});
test('collects dated and all-day calendar events including cancellations, and validates ranges', async () => {
    const f = fixture(url => {
        assert.equal(url.searchParams.get('showDeleted'), 'true'); assert.equal(url.searchParams.get('singleEvents'), 'true');
        return Response.json({items: [{id: 'a', status: 'confirmed', summary: 'Meeting', start: {date: '2026-10-29'}, end: {date: '2026-10-30'}}, {id: 'b', status: 'cancelled'}]});
    });
    const input = {...args, calendarId: 'primary', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z'};
    assert.equal((await collectGoogle('calendar', input, f.context, f.connections, f.fetcher)).count, 2);
    assert.ok([...f.files.values()].some(body => body.includes('cancelled')));
    await assert.rejects(collectGoogle('calendar', {...input, timeMax: input.timeMin}, f.context, f.connections, f.fetcher), /GOOGLE_CALENDAR_RANGE_INVALID/);
});
test('rejects unsupported encoding and handles multipart alternatives without attachment content', () => {
    const plain = message('a').payload;
    const material = mailMaterial({id: 'a', payload: {mimeType: 'multipart/alternative', parts: [plain,
        {mimeType: 'text/html', body: {data: Buffer.from('<p>duplicate</p>').toString('base64url')}}, {...plain, filename: 'secret.txt'}]}});
    assert.match(material.content, /I prefer TypeScript/); assert.doesNotMatch(material.content, /duplicate|secret.txt/);
    assert.throws(() => mailMaterial({id: 'a', payload: {...plain, headers: [{name: 'Content-Type', value: 'text/plain; charset=invalid-codec'}]}}), /GOOGLE_MAIL_ENCODING_UNSUPPORTED/);
});

test('classifies expired authorization, invalid clients, API disablement, quotas and local write failures without leaking details', async () => {
    for (const [error, expected] of [['invalid_grant', 'REAUTH_REQUIRED'], ['invalid_client', 'CLIENT_INVALID']]) {
        const f = fixture(() => Response.json({}));
        await assert.rejects(collectGoogle('gmail', args, f.context, f.connections,
            async () => Response.json({error, error_description: 'private-token'}, {status: 400})), new RegExp('GOOGLE_AUTH_' + expected));
        assert.equal(f.files.size, 0); assert.doesNotMatch(f.logs.join(''), /private-token/);
    }
    for (const [reason, expected] of [['accessNotConfigured', 'API_DISABLED'], ['userRateLimitExceeded', 'RATE_LIMITED']]) {
        const f = fixture(() => Response.json({error: {errors: [{reason}], message: 'private content'}}, {status: 403}));
        await assert.rejects(collectGoogle('gmail', args, f.context, f.connections, f.fetcher), new RegExp('GOOGLE_MAIL_LIST_' + expected));
        assert.equal(f.files.size, 0); assert.doesNotMatch(f.logs.join(''), /private content/);
    }
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]}) : Response.json(message('a')));
    f.context.vfs.writeFile = async () => {throw new Error('private filesystem detail');};
    await assert.rejects(collectGoogle('gmail', args, f.context, f.connections, f.fetcher), /GOOGLE_SOURCE_WRITE_FAILED/);
    assert.doesNotMatch(f.logs.join(''), /private filesystem/);
});

test('refuses to publish fetched evidence if the user changes the connection during collection', async () => {
    let refreshToken = 'original-refresh';
    const f = fixture(url => {
        if (url.pathname.endsWith('/messages')) return Response.json({messages: [{id: 'a'}]});
        refreshToken = 'replacement-refresh'; return Response.json(message('a'));
    });
    f.connections.resolve = async () => ({clientId: 'client', clientSecret: 'private-secret', refreshToken});
    await assert.rejects(collectGoogle('gmail', args, f.context, f.connections, f.fetcher), /GOOGLE_CONNECTION_CHANGED/);
    assert.equal(f.files.size, 0); assert.doesNotMatch(f.logs.join(''), /replacement-refresh|original-refresh/);
});

test('publishes mail as account-scoped email files and leaves calendar material as separate files', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]}) : Response.json(message('a')));
    const result = await collectGoogle('gmail', {...args, resource: 'mail'}, f.context, f.connections, f.fetcher);
    assert.equal(result.directory, 'evidence/google/personal/mail/default');
    assert.ok([...f.files.keys()].some(file => file.endsWith('.email')));
    assert.equal(result.include[0], 'file:evidence/google/personal/mail/default/*.email');
});
test('ships workflows inside the extension with visible graph layouts and one resource-discriminated tool', async () => {
    const {readFile} = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(new URL('../nestos-tool.json', import.meta.url), 'utf8'));
    assert.equal(manifest.flows.length, 2);
    for (const file of manifest.flows) {
        const flow = JSON.parse(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
        assert.equal(flow.nodes[0].config.toolId, 'google.collect');
        assert.ok(['mail', 'calendar'].includes(flow.nodes[0].config.args.resource));
        assert.ok(flow.layout.nodes.collect);
    }
});

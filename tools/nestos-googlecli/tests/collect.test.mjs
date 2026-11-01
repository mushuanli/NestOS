import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectGoogle as collectOperation} from '../node/collect.mjs';
import {mailMaterial} from '../node/materials.mjs';

const message = id => ({id, payload: {mimeType: 'text/plain', headers: [{name: 'Subject', value: 'Private subject'}],
    body: {data: Buffer.from('I prefer TypeScript.').toString('base64url')}}});
let operation = 0;
async function collectGoogle(service, args, context, ...rest) {context.operationId = 'operation-' + ++operation; return collectOperation(service, args, context, ...rest);}
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
        if (String(url).endsWith('/profile')) return Response.json({historyId: '100', emailAddress: 'account@fixture.invalid'});
        if (new URL(url).pathname.endsWith('/history')) return Response.json({historyId: '100'});
        return handler(new URL(url));
    };
    return {files, logs, calls, context, connections, fetcher};
}
const args = {connection: 'personal', directory: 'evidence/google', query: 'newer_than:30d', maxItems: 10};
test('reports the target-relative directory and cwd without logging query, message content or credentials', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]}) : Response.json(message('a')));
    const result = await collectGoogle('gmail', {...args, resource: 'mail'}, {...f.context, cwd: '/workspace'}, f.connections, f.fetcher);
    const event = JSON.parse(f.logs.at(-1));
    assert.equal(event.directory, result.directory); assert.equal(event.cwd, '/workspace');
    assert.equal(event.count, 1); assert.equal(event.complete, true); assert.equal(event.processed, 1);
    assert.equal(result.collection.batchCount, 1); assert.equal(event.stage, 'checkpoint-commit'); assert.equal(event.result, 'success');
    assert.doesNotMatch(f.logs.join(''), /newer_than|TypeScript|Private subject|private-/);
});
test('paginates Gmail, stores stable evidence, retains archived messages and keeps diagnostics private', async () => {
    let removed = false;
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json(removed ? {} : url.searchParams.has('pageToken')
        ? {messages: [{id: 'b'}]} : {messages: [{id: 'a'}], nextPageToken: 'next'}) : Response.json(message(url.pathname.split('/').at(-1))));
    const first = await collectGoogle('gmail', args, f.context, f.connections, f.fetcher);
    assert.equal(first.count, 2); assert.equal(first.complete, true);
    const before = [...f.files.entries()].filter(([path]) => path.endsWith('.md'));
    await collectGoogle('gmail', args, f.context, f.connections, f.fetcher); assert.deepEqual([...f.files.entries()].filter(([path]) => path.endsWith('.md')), before);
    removed = true;
    const next = await collectGoogle('gmail', args, f.context, f.connections, f.fetcher);
    assert.equal(next.removed, 0); assert.ok([...f.files.values()].some(body => body.includes('I prefer')));
    assert.doesNotMatch(f.logs.join(''), /private-|TypeScript|Private subject|newer_than/);
});
test('saves a bounded batch with continuation and refuses permission failures before source writes', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}, {id: 'b'}]}) : Response.json(message(url.pathname.split('/').at(-1))));
    const first = await collectGoogle('gmail', {...args, maxItems: 1}, f.context, f.connections, f.fetcher);
    assert.equal(first.count, 1); assert.equal(first.complete, false);
    assert.equal((await collectGoogle('gmail', {...args, maxItems: 1}, f.context, f.connections, f.fetcher)).complete, true);
    const denied = fixture(() => new Response('private upstream body', {status: 403}));
    await assert.rejects(collectGoogle('gmail', args, denied.context, denied.connections, denied.fetcher), /GOOGLE_MAIL_LIST_PERMISSION_DENIED/);
    assert.equal(denied.files.size, 0); assert.doesNotMatch(denied.logs.join(''), /private/);
});
test('collects dated and all-day calendar events including cancellations, and validates ranges', async () => {
    const events = [{id: 'a', status: 'confirmed', summary: 'Meeting', start: {date: '2026-10-29'}, end: {date: '2026-10-30'}}, {id: 'b', status: 'cancelled'}];
    const f = fixture(url => {
        if (!url.pathname.endsWith('/events')) return Response.json(events.find(item => item.id === url.pathname.split('/').at(-1)));
        assert.equal(url.searchParams.get('showDeleted'), 'true'); assert.equal(url.searchParams.get('singleEvents'), 'true');
        return Response.json({items: events, nextSyncToken: 'sync'});
    });
    const input = {...args, calendarId: 'primary', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z'};
    assert.equal((await collectGoogle('calendar', input, f.context, f.connections, f.fetcher)).count, 1);
    await assert.rejects(collectGoogle('calendar', {...input, timeMax: input.timeMin}, f.context, f.connections, f.fetcher), /GOOGLE_CALENDAR_RANGE_INVALID/);
});

test('records empty calendar sources in isolated directories', async () => {
    const f = fixture(() => Response.json({items: [], nextSyncToken: 'sync'}));
    const first = await collectGoogle('calendar', {...args, calendarId: 'primary'}, f.context, f.connections, f.fetcher);
    const second = await collectGoogle('calendar', {...args, calendarId: 'work'}, f.context, f.connections, f.fetcher);
    assert.notEqual(first.directory, second.directory);
    for (const directory of [first.directory, second.directory]) {
        const source = JSON.parse(f.files.get(directory + '/.calendar-source.json'));
        assert.equal(source.format, 'nestos.calendar-source');
        assert.equal(source.account, 'personal');
        assert.ok(Number.isSafeInteger(source.archivedAt));
        assert.doesNotMatch(JSON.stringify(source), /private-|newer_than/);
    }
    assert.equal(first.count, 0); assert.equal(second.count, 0);
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
    assert.equal(result.directory, '/workspace');
    assert.ok([...f.files.keys()].some(file => file.endsWith('.email')));
    assert.equal(result.include[0], 'file:/workspace/*.email');
});
test('advertises direct collection without installing single-node workflows and retains old templates for compatibility', async () => {
    const {readFile} = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(new URL('../nestos-tool.json', import.meta.url), 'utf8'));
    assert.equal(manifest.flows, undefined);
    for (const file of ['flows/google-gmail-collect.flow', 'flows/google-calendar-collect.flow']) {
        const flow = JSON.parse(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
        assert.equal(flow.nodes[0].config.toolId, 'google.collect');
        assert.ok(['mail', 'calendar'].includes(flow.nodes[0].config.args.resource));
        assert.ok(flow.layout.nodes.collect);
    }
});
test('uses the connection mail directory when a Gmail tool omits directory and resource', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: []}) : Response.json(message('a')));
    const original = f.connections.resolve;
    f.connections.resolve = async (...parameters) => ({...await original(...parameters), mailDirectory: 'mail-inbox'});
    const {directory, ...input} = args;
    const result = await collectGoogle('gmail', input, f.context, f.connections, f.fetcher);
    assert.match(result.directory, /^mail-inbox\/gmail-[a-f0-9]{24}$/);
});

test('fetches detached text bodies without downloading named attachments', async () => {
    const f = fixture(url => {
        if (url.pathname.endsWith('/messages')) return Response.json({messages: [{id: 'a'}]});
        if (url.pathname.endsWith('/attachments/text-body')) return Response.json({data: Buffer.from('Detached text body').toString('base64url'), size: 18});
        return Response.json({id: 'a', payload: {mimeType: 'multipart/mixed', parts: [
            {mimeType: 'text/plain', body: {attachmentId: 'text-body', size: 18}},
            {mimeType: 'text/plain', filename: 'private.txt', body: {attachmentId: 'never-download', size: 10}},
        ]}});
    });
    const result = await collectGoogle('gmail', {...args, resource: 'mail'}, f.context, f.connections, f.fetcher);
    assert.equal(result.count, 1); assert.equal(result.complete, true);
    assert.match([...f.files.values()].find(value => value.includes('Source: Gmail')), /Detached text body/);
    assert.ok(f.calls.some(url => url.includes('/attachments/text-body')));
    assert.ok(!f.calls.some(url => url.includes('never-download')));
});
test('archives empty and attachment-only messages explicitly, while rejecting missing or unsupported bodies', () => {
    for (const body of [{data: '', size: 0}, {size: 0}]) {
        assert.match(mailMaterial({id: 'empty', payload: {mimeType: 'text/plain', body}}).content, /Body-Status: empty/);
    }
    assert.match(mailMaterial({id: 'files', payload: {mimeType: 'multipart/mixed', parts: [
        {mimeType: 'application/pdf', filename: 'private.pdf', body: {attachmentId: 'file'}}]}}).content, /Body-Status: attachments-only/);
    assert.throws(() => mailMaterial({id: 'missing', payload: {mimeType: 'text/plain', body: {size: 42}}}), /GOOGLE_MAIL_BODY_UNAVAILABLE/);
    assert.throws(() => mailMaterial({id: 'encrypted', payload: {mimeType: 'application/pkcs7-mime'}}), /GOOGLE_MAIL_BODY_UNSUPPORTED/);
});
test('keeps the checkpoint unchanged when detached text cannot be read', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]})
        : url.pathname.includes('/attachments/') ? Response.json({error: {message: 'PRIVATE_ERROR'}}, {status: 403})
        : Response.json({id: 'a', payload: {mimeType: 'text/plain', body: {attachmentId: 'body', size: 10}}}));
    await assert.rejects(collectGoogle('gmail', args, f.context, f.connections, f.fetcher), /GOOGLE_MAIL_BODY_READ_PERMISSION_DENIED/);
    assert.ok(![...f.files.keys()].some(key => key.endsWith('.sync.json')));
    assert.doesNotMatch(f.logs.join(''), /PRIVATE_ERROR|private-/);
    assert.ok(f.logs.some(line => JSON.parse(line).mimeType === 'text/plain'));
});
test('does not let an empty message block other messages in the batch', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'empty'}, {id: 'full'}]})
        : Response.json(url.pathname.endsWith('/empty') ? {id: 'empty', payload: {mimeType: 'text/plain', body: {size: 0}}} : message('full')));
    const result = await collectGoogle('gmail', {...args, resource: 'mail'}, f.context, f.connections, f.fetcher);
    assert.equal(result.count, 2); assert.equal(result.complete, true);
    assert.ok([...f.files.values()].some(value => value.includes('Body-Status: empty')));
});
test('refuses oversized detached text before fetching and does not advance the checkpoint', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]})
        : Response.json({id: 'a', payload: {mimeType: 'text/plain', body: {attachmentId: 'oversized', size: 128 * 1024 + 1}}}));
    await assert.rejects(collectGoogle('gmail', args, f.context, f.connections, f.fetcher), /GOOGLE_MATERIAL_LIMIT/);
    assert.ok(!f.calls.some(url => url.includes('/attachments/')));
    assert.ok(![...f.files.keys()].some(key => key.endsWith('.sync.json')));
});

test('reports a stable safe identity and MIME part for missing body data without advancing the batch', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]})
        : Response.json({id: 'a', payload: {mimeType: 'multipart/alternative', parts: [
            {mimeType: 'text/plain', body: {size: 42}}]}}));
    await assert.rejects(collectGoogle('gmail', {...args, resource: 'mail'}, f.context, f.connections, f.fetcher), /GOOGLE_MAIL_BODY_UNAVAILABLE/);
    const event = f.logs.map(JSON.parse).find(item => item.diagnostic);
    assert.match(event.diagnostic.messageKey, /^[a-f0-9]{64}$/);
    assert.equal(event.diagnostic.partPath, '0.0');
    assert.equal(event.diagnostic.declaredBytes, 42);
    assert.equal(event.diagnostic.dataPresent, false);
    assert.equal(f.logs.map(JSON.parse).filter(item => item.result === 'failure').length, 1);
    assert.equal([...f.files.keys()].some(file => file.endsWith('.sync.json')), false);
    assert.ok(!f.logs.join('').includes('private-secret'));
});

test('rejects a nonempty declared body with empty data instead of archiving it as empty', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]})
        : Response.json({id: 'a', payload: {mimeType: 'text/plain', body: {data: '', size: 42}}}));
    await assert.rejects(collectGoogle('gmail', {...args, resource: 'mail'}, f.context, f.connections, f.fetcher), /GOOGLE_MAIL_BODY_UNAVAILABLE/);
    assert.equal(f.files.size, 0);
    const event = f.logs.map(JSON.parse).find(item => item.result === 'failure');
    assert.equal(event.diagnostic.phase, 'body-resolve');
    assert.equal(event.diagnostic.declaredBytes, 42);
});

test('retains safe part diagnostics for detached body read and validation failures', async () => {
    for (const response of [() => new Response('private upstream error', {status: 403}), () => Response.json({size: 42})]) {
        const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: [{id: 'a'}]})
            : url.pathname.includes('/attachments/') ? response()
            : Response.json({id: 'a', payload: {mimeType: 'multipart/mixed', parts: [
                {mimeType: 'text/plain', body: {attachmentId: 'private-attachment', size: 42}}]}}));
        await assert.rejects(collectGoogle('gmail', {...args, resource: 'mail'}, f.context, f.connections, f.fetcher),
            /GOOGLE_MAIL_BODY_(READ_PERMISSION_DENIED|INVALID_RESPONSE)/);
        assert.equal(f.files.size, 0);
        const events = f.logs.map(JSON.parse).filter(item => item.result === 'failure');
        assert.equal(events.length, 1);
        assert.equal(events[0].diagnostic.partPath, '0.0');
        assert.equal(events[0].diagnostic.phase, 'body-read');
        assert.doesNotMatch(f.logs.join(''), /private-|private upstream/);
    }
});


test('uses only the scanner-mounted output for modern collection and publishes a generic mailbox descriptor', async () => {
    const f = fixture(url => url.pathname.endsWith('/messages') ? Response.json({messages: []}) : Response.json(message('a')));
    const resolve = f.connections.resolve;
    f.connections.resolve = async (...parameters) => ({...await resolve(...parameters), mailDirectory: 'ignored-connection-path'});
    const result = await collectGoogle('gmail', {...args, directory: 'ignored-argument-path', resource: 'mail'}, {...f.context, cwd: '/workspace'}, f.connections, f.fetcher);
    assert.equal(result.directory, '/workspace');
    assert.ok([...f.files.keys()].every(path => path.startsWith('/workspace/')));
    const source = JSON.parse(f.files.get('/workspace/.mail-source.json'));
    assert.equal(source.format, 'nestos.mail-source'); assert.equal(source.provider.id, 'google'); assert.equal(source.account.id, 'personal');
    assert.doesNotMatch(f.logs.join(''), /ignored-connection-path|ignored-argument-path|Private subject|private-secret/);
});

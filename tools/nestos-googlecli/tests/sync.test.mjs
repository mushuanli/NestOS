import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectGoogle} from '../node/collect.mjs';
import {readBatch} from '../node/sync-batch.mjs';

const mail = id => ({id, payload: {mimeType: 'text/plain', headers: [{name: 'Message-ID', value: '<' + id + '@fixture.invalid>'}], body: {data: Buffer.from('Body ' + id).toString('base64url')}}});
const event = id => ({id, status: 'confirmed', summary: id, start: {date: '2026-10-20'}, end: {date: '2026-10-21'}});
const input = {resource: 'mail', connection: 'personal', directory: 'imports', query: 'newer_than:30d', maxItems: 2};
function fixture(handler) {
    const files = new Map(), calls = [], writes = [], logs = [];
    const vfs = {async readFile(path) {if (!files.has(path)) throw Object.assign(new Error('Missing'), {code: 'ENOENT'}); return files.get(path);},
        async writeFile(path, content) {files.set(path, content); writes.push(path);}};
    const context = {vfs, operationId: 'initial', onProgress: async progress => logs.push(progress.message)};
    const connections = {resolve: async () => ({clientId: 'client', clientSecret: 'PRIVATE_SECRET', refreshToken: 'PRIVATE_REFRESH'})};
    const fetcher = async (raw, init) => {
        const url = new URL(raw); calls.push(url);
        assert.equal(init.redirect, 'error');
        if (url.hostname === 'oauth2.googleapis.com') return Response.json({access_token: 'PRIVATE_ACCESS'});
        if (url.pathname.endsWith('/profile')) return Response.json({historyId: '100', emailAddress: 'account@fixture.invalid'});
        if (/\/messages\/[^/]+$/.test(url.pathname)) return Response.json(mail(decodeURIComponent(url.pathname.split('/').at(-1))));
        return handler(url);
    };
    return {files, calls, writes, logs, context, connections, fetcher,
        async run(operation, args = input, service = 'gmail') {context.operationId = operation; return collectGoogle(service, args, context, connections, fetcher);}};
}
const checkpoint = f => JSON.parse([...f.files.entries()].find(([path]) => path.endsWith('/.sync.json'))[1]);
const bodies = f => [...f.files.entries()].filter(([path]) => /\.(email|md)$/.test(path));

test('continues an oversized mailbox across batches, preserves page parameters and replays an older operation receipt', async () => {
    const f = fixture(url => {
        assert.equal(url.searchParams.get('maxResults'), '2');
        return Response.json(url.searchParams.has('pageToken') ? {messages: [{id: 'c'}]} : {messages: [{id: 'a'}, {id: 'b'}], nextPageToken: 'page-2'});
    });
    const first = await f.run('one'); assert.equal(first.complete, false); assert.equal(first.collection.processed, 2);
    const second = await f.run('two', {...input, maxItems: 1}); assert.equal(second.complete, true); assert.equal(second.collection.processed, 3);
    assert.equal(bodies(f).length, 3);
    const reads = f.calls.filter(url => /\/messages\//.test(url.pathname)).length;
    assert.deepEqual(await f.run('one'), first);
    assert.equal(f.calls.filter(url => /\/messages\//.test(url.pathname)).length, reads);
    assert.equal(checkpoint(f).historyId, '100');
    assert.doesNotMatch(f.logs.join(''), /PRIVATE_|Body|page-2|newer_than/);
});
test('does not advance the cursor on partial file writes, and retries use stable archive paths', async () => {
    const f = fixture(() => Response.json({messages: [{id: 'a'}, {id: 'b'}], nextPageToken: 'next'}));
    const write = f.context.vfs.writeFile; let failed = false;
    f.context.vfs.writeFile = async (path, content) => {if (path.endsWith('.email') && !failed && bodies(f).length === 1) {failed = true; throw new Error('PRIVATE_DISK');} await write(path, content);};
    await assert.rejects(f.run('one'), /GOOGLE_SOURCE_WRITE_FAILED/);
    assert.equal([...f.files.keys()].some(path => path.endsWith('/.sync.json')), false);
    const result = await f.run('one'); assert.equal(result.complete, false); assert.equal(bodies(f).length, 2);
    assert.equal(f.writes.filter(path => path === bodies(f)[0][0]).length, 1);
});
test('recovers a committed operation when writing its detached receipt fails before a later batch', async () => {
    const f = fixture(url => Response.json(url.searchParams.has('pageToken') ? {} : {messages: [{id: 'a'}, {id: 'b'}], nextPageToken: 'next'}));
    const first = await f.run('one'), write = f.context.vfs.writeFile; let failed = false;
    f.context.vfs.writeFile = async (path, content) => {if (path.includes('/.operations/') && !failed) {failed = true; throw new Error('Disk');} await write(path, content);};
    await assert.rejects(f.run('two'), /GOOGLE_SYNC_STATE_WRITE_FAILED/);
    assert.deepEqual(await f.run('one'), first);
    assert.equal((await f.run('two')).complete, true);
});
test('uses Gmail history for new matches and existing changes, preserves old mail outside a moving window', async () => {
    let history = 0;
    const f = fixture(url => {
        if (url.pathname.endsWith('/history')) {history++; return Response.json({historyId: '200', history: [{messagesAdded: [{message: {id: 'new'}}], labelsAdded: [{message: {id: 'old'}}]}]});}
        if (url.searchParams.get('q')?.includes('rfc822msgid')) return Response.json({messages: [{id: 'new'}]});
        return Response.json({messages: [{id: 'old'}]});
    });
    await f.run('full'); const result = await f.run('delta');
    assert.equal(history, 1); assert.equal(result.complete, true); assert.equal(bodies(f).length, 2); assert.equal(checkpoint(f).historyId, '200');
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/messages') && !url.searchParams.get('q')?.includes('rfc822msgid')).length, 1);
});
test('retains archives on history expiry and query changes, and resets expired cursors automatically', async () => {
    let expired = false, changed = false;
    const f = fixture(url => {
        if (url.pathname.endsWith('/history')) {if (!expired) {expired = true; return new Response('{}', {status: 404});} return Response.json({historyId: '200'});}
        return Response.json({messages: [{id: changed ? 'new-range' : 'old'}]});
    });
    await f.run('first'); await f.run('expired'); changed = true;
    await f.run('new-range', {...input, query: 'label:work'});
    assert.equal(bodies(f).length, 2); assert.ok(f.logs.some(log => log.includes('cursor-reset')));
});
test('retains remote-deleted mail as an archive and does not reread unchanged messages', async () => {
    const f = fixture(url => Response.json(url.pathname.endsWith('/history') ? {historyId: '200', history: [{messagesDeleted: [{message: {id: 'old'}}]}]} : {messages: [{id: 'old'}]}));
    await f.run('one'); await f.run('two');
    assert.equal(bodies(f).length, 1); assert.equal(f.calls.filter(url => /\/messages\//.test(url.pathname)).length, 1);
});
test('limits large pages by pending IDs without storing message bodies in the checkpoint', async () => {
    const f = fixture(() => Response.json({messages: ['a', 'b', 'c', 'd'].map(id => ({id}))}));
    assert.equal((await f.run('one')).complete, false);
    assert.deepEqual(checkpoint(f).pending.map(item => item.id), ['c', 'd']);
    assert.doesNotMatch(JSON.stringify(checkpoint(f)), /Body|payload/);
    assert.equal((await f.run('two')).complete, true); assert.equal(bodies(f).length, 4);
});
test('continues calendar pagination with identical bounds and uses syncToken without time bounds', async () => {
    const ranges = [], args = {...input, resource: 'calendar', calendarId: 'primary', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z', maxItems: 1};
    const f = fixture(url => {
        if (!url.pathname.endsWith('/events')) return Response.json(event(url.pathname.split('/').at(-1)));
        if (url.searchParams.has('syncToken')) {
            assert.equal(url.searchParams.has('timeMin'), false); assert.equal(url.searchParams.has('timeMax'), false);
            assert.equal(url.searchParams.get('syncToken'), 'sync-1'); return Response.json({nextSyncToken: 'sync-2', items: []});
        }
        ranges.push([url.searchParams.get('timeMin'), url.searchParams.get('timeMax')]);
        return Response.json(url.searchParams.has('pageToken') ? {items: [event('b')], nextSyncToken: 'sync-1'} : {items: [event('a')], nextPageToken: 'next'});
    });
    assert.equal((await f.run('one', args, 'calendar')).complete, false);
    assert.equal((await f.run('two', args, 'calendar')).complete, true);
    assert.equal((await f.run('three', args, 'calendar')).complete, true);
    assert.deepEqual(ranges[0], ranges[1]); assert.equal(bodies(f).length, 2);
});
test('resets expired calendar sync tokens without erasing archive files', async () => {
    const args = {...input, resource: 'calendar', calendarId: 'primary', timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z'};
    const f = fixture(url => {
        if (!url.pathname.endsWith('/events')) return Response.json(event(url.pathname.split('/').at(-1)));
        return url.searchParams.has('syncToken') ? new Response('{}', {status: 410}) : Response.json({items: [event('a')], nextSyncToken: 'sync'});
    });
    await f.run('one', args, 'calendar'); await f.run('two', args, 'calendar');
    assert.equal(bodies(f).length, 1); assert.ok(f.logs.some(log => log.includes('cursor-reset')));
});
test('recovers an unknown checkpoint write outcome without collecting another batch', async () => {
    const f = fixture(() => Response.json({messages: [{id: 'a'}, {id: 'b'}], nextPageToken: 'next'}));
    const write = f.context.vfs.writeFile; let failed = false;
    f.context.vfs.writeFile = async (path, content) => {await write(path, content); if (path.endsWith('/.sync.json') && !failed) {failed = true; throw new Error('Unknown write');}};
    await assert.rejects(f.run('one'), /GOOGLE_SYNC_STATE_WRITE_FAILED/);
    const reads = f.calls.filter(url => /\/messages\//.test(url.pathname)).length;
    const result = await f.run('one'); assert.equal(result.complete, false); assert.equal(result.count, 2);
    assert.equal(f.calls.filter(url => /\/messages\//.test(url.pathname)).length, reads);
});
test('automatically reduces a batch to its material byte budget instead of rejecting the complete query', async () => {
    const f = fixture(() => Response.json({messages: Array.from({length: 50}, (_, i) => ({id: String(i)}))}));
    const fetcher = f.fetcher;
    f.fetcher = async (url, init) => /\/messages\/[^/]+\?/.test(String(url)) ? Response.json({id: String(url).split('/').at(-1).split('?')[0],
        payload: {mimeType: 'text/plain', headers: [], body: {data: Buffer.from('a'.repeat(100 * 1024)).toString('base64url')}}}) : fetcher(url, init);
    const run = async op => {f.context.operationId = op; return collectGoogle('gmail', {...input, maxItems: 50}, f.context, f.connections, f.fetcher);};
    const first = await run('one'); assert.equal(first.complete, false); assert.ok(first.count > 0 && first.count < 50);
    assert.equal((await run('two')).complete, true); assert.equal(bodies(f).length, 50);
});
test('honors cancellation without advancing the cursor or saving a fetched batch', async () => {
    const controller = new AbortController();
    const f = fixture(() => {controller.abort(); return Response.json({messages: [{id: 'a'}]});});
    f.context.signal = controller.signal;
    await assert.rejects(f.run('one'), /GOOGLE_CANCELLED/);
    assert.equal(f.files.size, 0);
});
test('does not bypass authorization failures when a cursor is present', async () => {
    let denied = false;
    const f = fixture(() => denied ? new Response('{}', {status: 403}) : Response.json({messages: [{id: 'a'}]}));
    await f.run('one'); const previous = JSON.stringify(checkpoint(f)); denied = true;
    await assert.rejects(f.run('two'), /GOOGLE_MAIL_HISTORY_PERMISSION_DENIED/);
    assert.equal(JSON.stringify(checkpoint(f)), previous); assert.equal(bodies(f).length, 1);
});
test('refuses changed mailbox identities, including when the query also changes', async () => {
    const f = fixture(() => Response.json({messages: [{id: 'a'}]}));
    await f.run('one'); const previous = JSON.stringify(checkpoint(f)), fetcher = f.fetcher;
    f.fetcher = async (url, init) => String(url).endsWith('/profile') ? Response.json({historyId: '100', emailAddress: 'other@fixture.invalid'}) : fetcher(url, init);
    f.context.operationId = 'two';
    await assert.rejects(collectGoogle('gmail', {...input, query: 'label:other'}, f.context, f.connections, f.fetcher), /GOOGLE_CONNECTION_ACCOUNT_CHANGED/);
    assert.equal(JSON.stringify(checkpoint(f)), previous); assert.equal(bodies(f).length, 1);
    assert.doesNotMatch(f.logs.join(''), /other@|account@/);
});
test('rejects corrupted checkpoints without silently resetting or erasing archives', async () => {
    const f = fixture(() => Response.json({messages: [{id: 'a'}]})); await f.run('one');
    const path = [...f.files.keys()].find(path => path.endsWith('/.sync.json'));
    f.files.set(path, JSON.stringify({...checkpoint(f), pending: [{id: 'a', removed: 'yes'}]}));
    await assert.rejects(f.run('two'), /GOOGLE_SYNC_STATE_INVALID/);
    assert.equal(bodies(f).length, 1);
});
test('keeps pending history IDs until the last item and only then advances the history watermark', async () => {
    const f = fixture(url => {
        if (url.pathname.endsWith('/history')) return Response.json({historyId: '200', history: [{labelsAdded: ['a', 'b', 'c'].map(id => ({message: {id}}))}]});
        return Response.json({messages: ['a', 'b', 'c'].map(id => ({id}))});
    });
    await f.run('full-1'); await f.run('full-2');
    const first = await f.run('delta-1'); assert.equal(first.complete, false); assert.equal(checkpoint(f).historyId, '100');
    const next = await f.run('delta-2'); assert.equal(next.complete, true); assert.equal(checkpoint(f).historyId, '200');
});
test('preserves query filtering for new history messages without evicting existing archives', async () => {
    const f = fixture(url => {
        if (url.pathname.endsWith('/history')) return Response.json({historyId: '200', history: [{messagesAdded: [{message: {id: 'excluded'}}]}]});
        if (url.searchParams.get('q')?.includes('rfc822msgid')) return Response.json({});
        return Response.json({messages: [{id: 'old'}]});
    });
    await f.run('one'); const result = await f.run('two');
    assert.equal(result.complete, true); assert.equal(result.count, 0); assert.equal(bodies(f).length, 1);
    assert.equal(checkpoint(f).historyId, '200');
});
test('expands a rolling calendar horizon and retains the delta cursor captured before expansion', async () => {
    const args = {...input, resource: 'calendar', calendarId: 'primary'}, originalNow = Date.now;
    let now = Date.parse('2026-10-20T00:00:00Z'); Date.now = () => now;
    const f = fixture(url => {
        if (!url.pathname.endsWith('/events')) return Response.json(event('a'));
        if (url.searchParams.has('syncToken')) return Response.json({items: [], nextSyncToken: 'delta-new'});
        return Response.json({items: [], nextSyncToken: 'full-or-expansion'});
    });
    try {
        await f.run('one', args, 'calendar'); const oldEnd = checkpoint(f).rangeEnd; now += 86400000;
        assert.equal((await f.run('two', args, 'calendar')).complete, true);
        assert.equal(checkpoint(f).syncToken, 'delta-new');
        const expansion = f.calls.filter(url => url.pathname.endsWith('/events') && !url.searchParams.has('syncToken')).at(-1);
        assert.equal(expansion.searchParams.get('timeMin'), oldEnd);
        assert.ok(checkpoint(f).rangeEnd > oldEnd);
    } finally {Date.now = originalNow;}
});
test('freezes the scanner-mounted directory in Task assets across an unknown result', async () => {
    const f = fixture(() => Response.json({messages: [{id: 'a'}]})), assets = new Map(); let directory = 'first';
    f.context.cwd = 'first';
    const resolve = f.connections.resolve, write = f.context.vfs.writeFile; let unknown = true;
    f.connections.resolve = async () => ({...await resolve(), mailDirectory: directory});
    f.context.getAssetRecord = async key => assets.get(key);
    f.context.putAssetRecord = async (key, value) => {assets.set(key, value);};
    f.context.vfs.writeFile = async (path, content) => {await write(path, content); if (path.endsWith('/.sync.json') && unknown) {unknown = false; throw new Error('Unknown result');}};
    const {directory: _directory, ...args} = input;
    await assert.rejects(f.run('one', args), /GOOGLE_SYNC_STATE_WRITE_FAILED/);
    directory = 'second'; f.context.cwd = 'second'; assert.equal((await f.run('one', args)).complete, true);
    assert.ok([...f.files.keys()].every(path => path.startsWith('first/')));
});
test('yields a batch after its time budget instead of starting more provider work', async () => {
    const originalNow = Date.now; let now = 0, reads = 0; Date.now = () => now;
    const provider = {start: async () => ({mode: 'full', pending: [], processed: 0}),
        page: async state => {state.pending = Array.from({length: 10}, (_, id) => ({id: String(id)}));},
        read: async entry => {reads++; now += 16000; return {id: entry.id, content: 'Evidence'};}, advance: () => false, expired: () => false};
    try {
        const result = await readBatch(provider, null, {maxItems: 100}, {});
        assert.equal(reads, 3); assert.equal(result.complete, false); assert.equal(result.state.pending.length, 7);
    } finally {Date.now = originalNow;}
});

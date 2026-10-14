import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../../apps/web-app/public/sw.js', import.meta.url), 'utf8');
function worker() {
    const handlers = {}, writes = [], removed = [];
    const cache = { put: async request => writes.push(request.url), match: async () => undefined };
    runInNewContext(source, { URL, Response, caches: { open: async () => cache, delete: async name => removed.push(name) },
        fetch: async () => new Response('fresh'), self: { location: { origin: 'https://app.test' }, registration: { scope: 'https://app.test/' },
            addEventListener: (name, handler) => { handlers[name] = handler; }, skipWaiting() {}, clients: { claim: async () => {} } } });
    return { handlers, writes, removed };
}
test('does not cache development modules, APIs, authenticated files or other origins', () => {
    const { handlers } = worker();
    for (const url of ['https://app.test/@fs/shared/common/src/i18n/index.ts', 'https://app.test/api/files', 'https://remote.test/assets/file.js']) {
        handlers.fetch({ request: new Request(url), respondWith() { assert.fail('request must bypass app cache'); } });
    }
    handlers.fetch({ request: new Request('https://app.test/assets/file.js', { headers: { Authorization: 'Bearer test' } }),
        respondWith() { assert.fail('credentials must bypass app cache'); } });
});
test('caches app assets and removes the legacy module cache on activation', async () => {
    const { handlers, writes, removed } = worker(), pending = [];
    handlers.fetch({ request: new Request('https://app.test/assets/index-hash.js'), waitUntil: work => pending.push(work),
        respondWith: work => pending.push(work) });
    await Promise.all(pending); await Promise.all(pending);
    assert.deepEqual(writes, ['https://app.test/assets/index-hash.js']);
    handlers.activate({ waitUntil: work => pending.push(work) }); await Promise.all(pending);
    assert.deepEqual(removed, ['x1-v1']);
});

test('registers cache lifetime work synchronously and excludes API navigations', async () => {
    const { handlers } = worker();
    let dispatching = true;
    const pending = [];
    handlers.fetch({ request: new Request('https://app.test/assets/app-hash.js'),
        waitUntil(work) { assert.equal(dispatching, true); pending.push(work); },
        respondWith(work) { pending.push(work); } });
    dispatching = false;
    await Promise.all(pending);
    for (const url of ['https://app.test/api/files', 'https://app.test/?token=secret']) {
        handlers.fetch({ request: { url, method: 'GET', mode: 'navigate', headers: new Headers() },
            respondWith() { assert.fail('navigation outside the shell must bypass cache'); } });
    }
});

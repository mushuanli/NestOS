// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { WORKSPACES } from '../../../apps/web-app/src/config/modules';
import { createBrowserUI } from '../../../apps/web-app/src/ui';
import { installBootCache } from '../../../apps/http-app/src/client/view-client';
import { RpcPeer } from '../../../apps/http-app/src/application/peer';
import { QueryBatcher } from '../../../apps/http-app/src/client/query-batcher';
import type { Call, Reply } from '../../../apps/http-app/src/rpc/protocol';
import { installViewProjections } from '../../../apps/http-app/src/application/projections';
import { createHostedView } from '../../../apps/http-app/src/server/view-services';

const releases: Array<() => Promise<void>> = [];
const wireBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
it.each(['chat', 'minds'])('mounts the complete common shell starting at %s without eager feature services', async slug => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    const { initApp } = await import('../src/bootstrap');
    const html = readFileSync('../../apps/web-app/index.html', 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
    history.replaceState({}, '', slug === 'minds' ? '/#/minds/' + encodeURIComponent('/简历.mind') : '/#/chat');
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    if (slug === 'minds') {
        const fs = await runtime.vfs.openFileSystem('/home/admin/minds');
        await fs.driver.createFile({ parentPath: '/', name: '简历.mind', content: '# Resume' });
    }
    const view = await createHostedView(runtime);
    expect([...view.root.prepared.fileSystems.keys()]).toEqual(['/etc']); releases.push(() => view.close());
    let server!: RpcPeer;
    const metrics = { calls: 0, callbacks: 0, bytes: 0, requests: 0 };
    const measured = async (kind: 'calls' | 'callbacks', operation: () => Promise<any>) => { metrics[kind]++; const reply = await operation(); metrics.bytes += wireBytes(reply); return reply; };
    const batch = async (calls: Call[]): Promise<Reply[]> => {
        metrics.requests++; metrics.calls += calls.length;
        const replies = await Promise.all(calls.map(call => server.handle(call, false))), updates = await server.refresh();
        metrics.bytes += wireBytes({ replies, updates }); client.applyUpdates(updates); return replies;
    };
    const queries = new QueryBatcher(batch, () => {}), bindings = new QueryBatcher(batch, () => {});
    const client = new RpcPeer('client', call => {
        if (client.remoteQuery(call)) return queries.query(call);
        if (client.remoteBinding(call)) return bindings.query(call);
        metrics.requests++; return measured('calls', () => server.handle(call));
    }, console.error, installViewProjections);
    server = new RpcPeer('server', async call => { client.applyUpdates(await server.refresh()); return measured('callbacks', () => client.handle(call)); }, console.error, undefined, domains => view.prepare(server, domains));
    releases.push(() => client.close(), () => server.close());
    const { value: boot, updates } = await server.bootstrap(view.root);
    client.applyUpdates(updates); const root = client.decode(boot!);
    const bootstrapBytes = wireBytes({ value: boot, updates });
    console.log('[HTTP bootstrap bytes]', bootstrapBytes);
    expect(bootstrapBytes).toBeLessThan(350000);
    installBootCache(root);
    const before = { ...metrics };
    const calls: Record<string, number> = {};
    const handle = server.handle.bind(server);
    server.handle = (call, refresh) => { calls[call.method] = (calls[call.method] ?? 0) + 1; return handle(call, refresh); };
    const started = performance.now();
    const app = await initApp({ services: root.services, backend: root.backend, fileTemplates: root.fileTemplates,
        workspaces: WORKSPACES, defaultSlug: slug, ui: createBrowserUI(root.flowLibrary) }).catch(error => { console.error(error.errors); throw error; });
    releases.push(() => app.destroy());
    const startup = { calls: metrics.calls - before.calls, requests: metrics.requests - before.requests, callbacks: metrics.callbacks - before.callbacks,
        responseBytes: metrics.bytes - before.bytes, inProcessMs: Math.round(performance.now() - started) };
    console.log('[HTTP startup metrics]', startup);
    expect(startup.requests).toBeLessThanOrEqual(20); expect(startup.responseBytes).toBeLessThan(64000);
    console.log('[HTTP startup methods]', calls);
    for (const method of ['settings', 'ocr', 'readSettings', 'prepareConfiguration', 'initialFiles']) expect(calls[method]).toBeUndefined();
    for (const workspace of WORKSPACES) expect(document.getElementById(workspace.elementId)).not.toBeNull();
    for (const slug of WORKSPACES.map(workspace => workspace.slug)) await app.navigate(slug);
    expect(document.querySelectorAll('.app-nav-btn[hidden]')).toHaveLength(0);
    const id = await root.services.projects.sessions.create('HTTP conversation', null);
    await app.navigate('chat', id);
    expect(document.querySelector('.llm-input')).not.toBeNull();
    console.log('[HTTP navigation metrics]', metrics);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { WORKSPACES } from '../../../apps/web-app/src/config/modules';
import { createBrowserUI } from '../../../apps/web-app/src/ui';
import { RpcPeer } from '@itookit/app-transport/application';
import { QueryBatcher } from '@itookit/app-transport/http';
import type { Call, Reply } from '@itookit/app-transport/rpc';
import { installViewProjections } from '@itookit/app-transport/application';
import { createHostedView } from '@itookit/node-host/http';

const releases: Array<() => Promise<void>> = [];
const wireBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
it.each(['start', 'chat', 'minds'])('mounts the complete common shell starting at %s without eager feature services', async slug => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    const { initApp } = await import('../src/bootstrap');
    const html = readFileSync('../../apps/web-app/index.html', 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
    history.replaceState({}, '', slug === 'minds' ? '/#/minds/' + encodeURIComponent('/简历.mind') : slug === 'start' ? '/' : '/#/chat');
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    if (slug === 'minds') {
        const fs = await runtime.vfs.openFileSystem('/home/admin/minds');
        await fs.driver.createFile({ parentPath: '/', name: '简历.mind', content: '# Resume' });
    }
    const view = await createHostedView(runtime);
    releases.push(() => view.close());
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
    const before = { ...metrics };
    const calls: Record<string, number> = {};
    let releaseWorkbench!: () => void;
    const workbenchGate = slug === 'start' ? new Promise<void>(resolve => { releaseWorkbench = resolve; }) : undefined;
    const handle = server.handle.bind(server);
    server.handle = (call, refresh) => {
        calls[call.method] = (calls[call.method] ?? 0) + 1;
        return call.method === 'workbenchView' && workbenchGate ? workbenchGate.then(() => handle(call, refresh)) : handle(call, refresh);
    };
    const started = performance.now();
    const app = await initApp({ services: root.services, backend: root.backend, fileTemplates: root.fileTemplates,
        workspaces: WORKSPACES, startPage: true, defaultSlug: slug, ui: createBrowserUI(root.flowLibrary) }).catch(error => { console.error(error.errors); throw error; });
    releases.push(() => app.destroy());
    if (workbenchGate) releases.push(async () => releaseWorkbench());
    const startup = { calls: metrics.calls - before.calls, requests: metrics.requests - before.requests, callbacks: metrics.callbacks - before.callbacks,
        responseBytes: metrics.bytes - before.bytes, inProcessMs: Math.round(performance.now() - started) };
    console.log('[HTTP startup metrics]', startup);
    expect(startup.requests).toBeLessThanOrEqual(slug === 'chat' ? 9 : 13); expect(startup.responseBytes).toBeLessThan(64000);
    console.log('[HTTP startup methods]', calls);
    for (const method of ['settings', 'ocr', 'readSettings', 'prepareConfiguration', 'initialFiles']) expect(calls[method]).toBeUndefined();
    if (slug === 'start') {
        expect(startup.calls).toBe(1); expect(startup.requests).toBe(1);
        for (const method of ['workbenchView', 'openSessionView', 'openFileSystem']) expect(calls[method]).toBeUndefined();
        expect(document.querySelector('.app-start.active')).not.toBeNull();
        expect(document.querySelector('.app-start__choice')).not.toBeNull();
    }
    if (slug === 'start') {
        for (const method of Object.keys(calls)) delete calls[method];
        await app.navigate('minds');
        console.log('[HTTP first nav methods]', calls);
        expect(calls.navigationView).toBe(1);
        for (const method of ['openFileSystem', 'readUiDocuments', 'getChildren', 'getNodeType', 'createFile', 'readContent']) expect(calls[method]).toBeUndefined();
        await app.navigate('start');
        for (const method of Object.keys(calls)) delete calls[method];
        await app.navigate('minds');
        for (const method of ['navigationView', 'getChildren', 'getNodeType']) expect(calls[method]).toBeUndefined();
        const route = location.hash;
        await vi.waitFor(() => expect(calls.workbenchView).toBe(1), { timeout: 5000 });
        expect(calls.toolboxView).toBe(1);
        expect(document.querySelector('.toolbox-navigation')?.textContent).toContain('模型');
        expect(location.hash).toBe(route);
        expect(document.getElementById('minds-workspace')?.classList.contains('active')).toBe(true);
        expect(calls.openSessionView).toBeUndefined(); expect(document.querySelector('.llm-input')).toBeNull();
        for (const method of ['settings', 'ocr', 'prepareConfiguration', 'prepareSession', 'acquireFiles']) expect(calls[method]).toBeUndefined();
        // A foreground click joins the existing preload instead of creating another workbench.
        const joined = app.navigate('chat'); releaseWorkbench(); await joined;
        expect(calls.workbenchView).toBe(1);
        await app.navigate('toolbox'); expect(calls.toolboxView).toBe(1);
        expect(calls.openSessionView).toBeUndefined(); expect(document.querySelector('.llm-input')).toBeNull();
    }
    for (const workspace of WORKSPACES) expect(document.getElementById(workspace.elementId)).not.toBeNull();
    for (const slug of WORKSPACES.map(workspace => workspace.slug)) await app.navigate(slug);
    expect(document.querySelectorAll('.app-nav-btn[hidden]')).toHaveLength(0);
    const id = await root.services.projects.sessions.create('HTTP conversation', null);
    for (const method of Object.keys(calls)) delete calls[method];
    await app.navigate('chat', id);
    console.log('[HTTP open Session methods]', calls);
    expect(calls.openSessionView).toBe(1); expect(calls.activate).toBe(1);
    expect(calls.prepareSession).toBeUndefined(); expect(calls.acquireFiles).toBeUndefined(); expect(calls.fixedWorkspace).toBeUndefined();
    expect(document.querySelector('.llm-input')).not.toBeNull();
    const second = await root.services.projects.sessions.create('Second HTTP conversation', null);
    await app.navigate('chat', second); expect(root.services.sessionManager.getSnapshot().sessionId).toBe(second);
    await app.navigate('chat', id); expect(root.services.sessionManager.getSnapshot().sessionId).toBe(id);
    document.querySelector<HTMLButtonElement>(`[data-tab-id="${second}"] .workbench-tabs__close`)!.click();
    await vi.waitFor(() => expect(document.querySelector(`[data-tab-id="${second}"]`)).toBeNull());
    expect(root.services.sessionManager.getSnapshot().sessionId).toBe(id);


    console.log('[HTTP navigation metrics]', metrics);
});

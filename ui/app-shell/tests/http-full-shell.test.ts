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
it.each(['start', 'chat', 'notes', 'session'])('mounts the complete common shell starting at %s without eager feature services', async slug => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    const { initApp } = await import('../src/bootstrap');
    const html = readFileSync('../../apps/web-app/index.html', 'utf8');
    document.body.replaceWith(document.importNode(new DOMParser().parseFromString(html, 'text/html').body, true));
    history.replaceState({}, '', slug === 'notes' ? '/#/notes/' + encodeURIComponent('/简历.mind') : slug === 'start' ? '/' : '/#/chat');
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    if (slug === 'session') {
        const id = await runtime.projects.sessions.create('Cold HTTP conversation', null);
        history.replaceState({}, '', '/#/chat/' + encodeURIComponent(id));
    }
    if (slug === 'notes') {
        const fs = await runtime.vfs.openFileSystem('/home/admin/notes');
        await fs.driver.createFile({ parentPath: '/', name: '简历.mind', content: '# Resume' });
    }
    const view = await createHostedView(runtime);
    releases.push(() => view.close());
    let server!: RpcPeer;
    const metrics = { calls: 0, callbacks: 0, bytes: 0, requests: 0 };
    const requestGroups: string[][] = [];
    const pendingRequests = new Set<Promise<unknown>>();
    const track = <T>(pending: Promise<T>): Promise<T> => {
        pendingRequests.add(pending);
        void pending.finally(() => pendingRequests.delete(pending)).catch(() => {});
        return pending;
    };
    const measured = async (kind: 'calls' | 'callbacks', operation: () => Promise<any>) => { metrics[kind]++; const reply = await operation(); metrics.bytes += wireBytes(reply); return reply; };
    const batch = async (calls: Call[]): Promise<Reply[]> => {
        requestGroups.push(calls.map(call => call.method));
        metrics.requests++; metrics.calls += calls.length;
        const replies = await Promise.all(calls.map(call => server.handle(call, false))), updates = await server.refresh();
        metrics.bytes += wireBytes({ replies, updates }); client.applyUpdates(updates); return replies;
    };
    const queries = new QueryBatcher(calls => track(batch(calls)), () => {}), bindings = new QueryBatcher(calls => track(batch(calls)), () => {});
    const client = new RpcPeer('client', call => {
        if (client.remoteQuery(call)) return queries.query(call);
        if (client.remoteBinding(call)) return bindings.query(call);
        requestGroups.push([call.method]); metrics.requests++; return track(measured('calls', () => server.handle(call)));
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
        if (call.method === 'execute') calls[`execute:${call.args[0]}`] = (calls[`execute:${call.args[0]}`] ?? 0) + 1;
        return call.method === 'workbenchView' && workbenchGate ? workbenchGate.then(() => handle(call, refresh)) : handle(call, refresh);
    };
    const started = performance.now();
    const ui = createBrowserUI(root.flowLibrary), createChatEditor = ui.createChatEditor;
    const loaded: unknown[] = [];
    ui.createChatEditor = (service, deps) => createChatEditor(service, {...deps, onLoadMetrics: value => { loaded.push(value); }});
    const app = await initApp({ services: root.services, backend: root.backend, fileTemplates: root.fileTemplates,
        workspaces: WORKSPACES, startPage: true, defaultSlug: slug, ui }).catch(error => { console.error(error.errors); throw error; });
    expect(document.body.hasAttribute('data-app-starting')).toBe(false);
    releases.push(() => app.destroy());
    if (workbenchGate) releases.push(async () => releaseWorkbench());
    const startup = { calls: metrics.calls - before.calls, requests: metrics.requests - before.requests, callbacks: metrics.callbacks - before.callbacks,
        responseBytes: metrics.bytes - before.bytes, inProcessMs: Math.round(performance.now() - started) };
    console.log('[HTTP startup metrics]', startup);
    expect(startup.requests).toBeLessThanOrEqual(slug === 'session' ? 5 : slug === 'chat' ? 9 : 13); expect(startup.responseBytes).toBeLessThan(slug === 'session' ? 350000 : 64000);
    console.log('[HTTP startup methods]', calls);
    if (slug === 'session') {
        expect(loaded).toHaveLength(1);
        console.log('[HTTP Session ready]', loaded);
        console.log('[HTTP Session request groups]', requestGroups);
        expect(calls.openView).toBe(1); expect(calls.observeView).toBe(1);
        for (const method of ['workbenchView', 'openSessionView', 'activate', 'readUiDocuments']) expect(calls[method]).toBeUndefined();
        for (const method of ['getConnections', 'getDefaultConnection', 'getSystemPrompt', 'execute:session.get-snapshot'])
            expect(calls[method]).toBeUndefined();
        expect(document.querySelector('.llm-input')).not.toBeNull();
        await vi.waitFor(() => expect(calls.navigation).toBeGreaterThanOrEqual(1));
        while (pendingRequests.size) await Promise.all([...pendingRequests]);
        expect(calls.openSession).toBeUndefined(); expect(calls.getShared).toBeUndefined();
        expect(calls.listSessionPendingInteractionTasks).toBeUndefined();
        for (const method of ['taskAttachment', 'onGlobalEvent', 'onEvent', 'subscribe', 'onChange', 'onChanged', 'onPromoted', 'list', 'execute:session.flow.invocations'])
            expect(calls[method]).toBeUndefined();
        console.log('[HTTP Session recovery metrics]', {...metrics, methods: calls, requestGroups});
        return;
    }
    for (const method of ['settings', 'ocr', 'readSettings', 'prepareConfiguration', 'initialFiles']) expect(calls[method]).toBeUndefined();
    if (slug === 'start') {
        expect(startup.calls).toBe(1); expect(startup.requests).toBe(1);
        for (const method of ['workbenchView', 'openSessionView', 'openFileSystem']) expect(calls[method]).toBeUndefined();
        expect(document.querySelector('.app-start.active')).not.toBeNull();
        expect(document.querySelector('.app-start__choice')).not.toBeNull();
    }
    if (slug === 'start') {
        for (const method of Object.keys(calls)) delete calls[method];
        await app.navigate('notes');
        console.log('[HTTP first nav methods]', calls);
        expect(calls.navigationView).toBe(1);
        for (const method of ['openFileSystem', 'readUiDocuments', 'getChildren', 'getNodeType', 'createFile', 'readContent']) expect(calls[method]).toBeUndefined();
        await app.navigate('start');
        for (const method of Object.keys(calls)) delete calls[method];
        await app.navigate('notes');
        for (const method of ['navigationView', 'getChildren', 'getNodeType']) expect(calls[method]).toBeUndefined();
        const route = location.hash;
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(calls.workbenchView).toBeUndefined(); expect(calls.toolboxView).toBeUndefined();
        expect(location.hash).toBe(route);
        expect(document.getElementById('notes-workspace')?.classList.contains('active')).toBe(true);
        expect(calls.openSessionView).toBeUndefined(); expect(document.querySelector('.llm-input')).toBeNull();
        for (const method of ['settings', 'ocr', 'prepareConfiguration', 'prepareSession', 'acquireFiles']) expect(calls[method]).toBeUndefined();
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

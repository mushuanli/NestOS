import {afterEach, expect, it, vi} from 'vitest';
import {createApplicationRuntime} from '@itookit/app-core';
import {MemoryBackend} from '@itookit/vfs-core';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';
import {createHostedView} from '@itookit/node-host/http';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => {for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks();});
async function setup() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', digitalTwinAutoStart: false,
        remoteSourceProvider: {setCredential() {}, async open() {throw new Error('not used');}, async dispose() {}}});
    releases.push(() => runtime.dispose());
    const view = await createHostedView(runtime); releases.push(() => view.close());
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, console.error,
        undefined, domains => view.prepare(server, domains));
    releases.push(() => client.close(), () => server.close());
    const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
    return {root, runtime, client};
}
it('queries and observes backend diagnostics through the real RPC graph, scoped to the owning runtime', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await setup(), b = await setup(), changed = vi.fn();
    expect(a.root.services.diagnostics).toBeUndefined();
    const stop = a.root.backend.diagnostics.onChange(changed); await a.client.whenIdle();
    a.runtime.diagnostics.record({module: 'cells', operation: 'project.connection', stage: 'root-probe', result: 'failure', level: 'error',
        projectId: 'project-a', connectionId: 'office', code: 'EACCES'});
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect((await a.root.backend.diagnostics.query({projectId: 'project-a'})).events).toEqual([expect.objectContaining({code: 'EACCES', connectionId: 'office'})]);
    expect((await b.root.backend.diagnostics.query({projectId: 'project-a'})).events).toEqual([]);
    for (let index = 0; index < 21; index++) a.runtime.diagnostics.record({module: 'application', operation: 'test.page', stage: 'query',
        result: 'success', level: 'info', projectId: 'paging', code: 'EVENT_' + index});
    const first = await a.root.backend.diagnostics.query({projectId: 'paging', limit: 20, offset: 0});
    const second = await a.root.backend.diagnostics.query({projectId: 'paging', limit: 20, offset: 20});
    expect(first).toMatchObject({matchingGroups: 21, offset: 0, truncated: true}); expect(first.events).toHaveLength(20);
    expect(second).toMatchObject({matchingGroups: 21, offset: 20, truncated: false, events: [expect.objectContaining({code: 'EVENT_0'})]});
    expect((await b.root.backend.diagnostics.query({projectId: 'paging', offset: 20, limit: 20})).events).toEqual([]);
    expect(await a.root.services.projects.remoteMounts.projectStatus('project-a')).toMatchObject({projectId: 'project-a', status: 'unknown', mounts: []});
    await expect(a.root.services.projects.remoteMounts.refreshProjectBinding('missing')).rejects.toMatchObject({code: 'ECAPABILITY'});
    await expect(a.root.services.agentService.refreshMCPServer('missing')).rejects.toMatchObject({code: 'MCP_REFRESH_UNAVAILABLE'});
    stop(); await a.client.whenIdle(); const calls = changed.mock.calls.length;
    a.runtime.diagnostics.record({module: 'application', operation: 'application.test', stage: 'complete', result: 'success', level: 'info'});
    await a.client.whenIdle(); expect(changed).toHaveBeenCalledTimes(calls);
});

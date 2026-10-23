import { afterEach, expect, it } from 'vitest';
import { createApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { RpcPeer, installViewProjections } from '@itookit/app-transport/application';
import { createHostedView } from '@itookit/node-host/http';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });

it('persists the local default and returns its pinned navigation through the actual RPC capability', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', digitalTwinAutoStart: false});
    releases.push(() => runtime.dispose());
    const view = await createHostedView(runtime); releases.push(() => view.close());
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => { client.applyUpdates(await server.refresh()); return client.handle(call); },
        console.error, undefined, domains => view.prepare(server, domains));
    releases.push(() => client.close(), () => server.close());
    const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
    const projects = root.services.projects;
    const chosen = await projects.create('ZZZ explicit default');
    await projects.setDefaultProject(chosen.project.id);
    expect((await projects.getDefaultProject()).project.id).toBe(chosen.project.id);
    const navigation = await projects.navigation({path: '/'});
    expect(navigation.defaultProjectId).toBe(chosen.project.id);
    expect(navigation.projects[0].project.id).toBe(chosen.project.id);
    expect((await runtime.projects.current())?.project.id).toBe(chosen.project.id);
    await expect(projects.setDefaultProject('nonexistent')).rejects.toMatchObject({code: 'ENOENT'});
    expect((await projects.getDefaultProject()).project.id).toBe(chosen.project.id);
});

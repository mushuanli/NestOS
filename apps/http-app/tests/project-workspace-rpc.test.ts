import {expect, it, vi} from 'vitest';
import {createApplicationRuntime} from '@itookit/app-core';
import {MemoryBackend} from '@itookit/vfs-core';
import {RpcPeer} from '@itookit/app-transport/application';

it('transports prepared file metadata with the workspace lease and preserves release ownership', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false});
    const report = vi.fn(), server = new RpcPeer('server', async () => ({value: null}), report);
    const client = new RpcPeer('client', call => server.handle(call), report);
    let source: Awaited<ReturnType<typeof runtime.projects.openWorkspace>> | undefined;
    try {
        const project = await runtime.projects.create('RPC workspace');
        source = await runtime.projects.openWorkspace(project.path, {initialPath: '/workspace'});
        const dispose = vi.spyOn(source, 'dispose'), boot = await server.bootstrap(source);
        client.applyUpdates(boot.updates); const remote = client.decode(boot.value!);
        expect(remote.initialFile).toMatchObject({node: {path: '/workspace', type: 'directory'}, readonly: false});
        expect(remote.fs.viewId).toBe(source.fs.viewId); expect(dispose).not.toHaveBeenCalled();
        await remote.dispose(); expect(dispose).toHaveBeenCalledOnce(); source = undefined;
        expect(report).not.toHaveBeenCalled();
    } finally {await client.close(); await server.close(); await source?.dispose(); await runtime.dispose();}
}, 15000);

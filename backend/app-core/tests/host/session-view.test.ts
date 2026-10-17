import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../../src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../../src/host/application-services';
import { ViewScope } from '../../src/host/view-scope';
import { bindApplicationBackend, createApplicationClient } from '../../src/host/application-client';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';
import type { FileSystemContextOwner } from '@itookit/vfs-core';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
it('prepares one file lease without rebinding, then activates once the caller is ready', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); releases.push(() => client.close());
    const id = await runtime.projects.sessions.create('Prepared', null);
    const view = await client.backend.openSessionView(id);
    expect(view.manifest.id).toBe(id); expect(view.context.sessionId).toBe(id);
    expect(runtime.sessionManager.getSnapshot().sessionId).not.toBe(id);
    const initial = await view.activate();
    expect(initial).toMatchObject({ sessionId: id, manifest: { title: 'Prepared' }, snapshot: { sessionId: id } });
    await view.dispose(); await view.dispose();
    expect(runtime.sessionManager.getSnapshot().sessionId).toBe(id);
    await expect(view.activate()).rejects.toThrow('closed');
});
it('releases a late file lease if the client closes while preparation is in flight', async () => {
    let resolve!: (owner: FileSystemContextOwner) => void;
    const release = vi.fn(async () => {});
    const services = { sessionRepository: { getManifest: async () => ({ id: 's' }) },
        sessionFiles: { acquireFiles: () => new Promise<FileSystemContextOwner>(done => { resolve = done; }) } } as unknown as LocalApplicationServices;
    const scope = new ViewScope(), backend = bindApplicationBackend(services, {}, scope);
    const client = { backend, close: () => scope.close() };
    const pending = client.backend.openSessionView('s');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await client.close(); resolve({ context: {} as never, release });
    await expect(pending).rejects.toThrow('closed'); expect(release).toHaveBeenCalledOnce();
});
it('does not acquire files when preparing a missing Session fails', async () => {
    const acquireFiles = vi.fn(), execute = vi.fn();
    const scope = new ViewScope();
    const backend = bindApplicationBackend({ sessionRepository: { getManifest: async () => { throw new Error('missing'); } },
        sessionFiles: { acquireFiles }, commandBus: { execute } } as unknown as LocalApplicationServices, {}, scope);
    const client = { backend, close: () => scope.close() };
    await expect(client.backend.openSessionView('s')).rejects.toThrow('missing');
    expect(acquireFiles).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); await client.close();
});

it('prepares a cold target with the workbench without binding it and releases unused preparation', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    releases.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); releases.push(() => client.close());
    const id = await runtime.projects.sessions.create('Cold target', null);
    const workspace = await client.backend.workbenchView({initialNavigation: false, initialSessionId: id});
    expect(workspace.initialSession?.manifest.id).toBe(id);
    expect(runtime.sessionManager.getSnapshot().sessionId).not.toBe(id);
    await client.close();
    await expect(workspace.initialSession!.activate()).rejects.toThrow('closed');
});

it('keeps navigation usable for a missing initial target and cleans preparation after navigation failure', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    releases.push(() => runtime.dispose());
    const services = bindLocalApplicationServices(runtime), client = createApplicationClient(services); releases.push(() => client.close());
    const missing = await client.backend.workbenchView({initialNavigation: false, initialSessionId: 'missing'});
    expect(missing.initialSession).toBeUndefined(); await missing.browser.dispose();
    const id = await runtime.projects.sessions.create('Prepared before failure', null);
    const acquire = services.sessionFiles.acquireFiles.bind(services.sessionFiles), release = vi.fn();
    vi.spyOn(services.sessionFiles, 'acquireFiles').mockImplementation(async (...args) => {
        const owner = await acquire(...args);
        return {...owner, release: async () => {release(); await owner.release();}};
    });
    vi.spyOn(services.projects, 'navigation').mockRejectedValueOnce(new Error('navigation failed'));
    await expect(client.backend.workbenchView({initialSessionId: id})).rejects.toThrow('navigation failed');
    expect(release).toHaveBeenCalledOnce();
});

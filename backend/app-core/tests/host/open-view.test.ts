import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '../../src/runtime/create-application-runtime';
import {openApplicationView} from '../../src/host/application-view';
import {bindLocalApplicationServices} from '../../src/host/application-services';
import {createApplicationClient} from '../../src/host/application-client';
import {FlowInvocationCommand} from '@itookit/llm-session/contracts';
import type {ApplicationViewEvent} from '@itookit/app-contracts/services';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    closes.push(() => runtime.dispose()); return runtime;
}
const request = (id: string) => ({documents: ['theme'], taskAttachmentKey: 'ui.privileged.active-task',
    workbench: {initialSessionId: id, chatControls: true, initialNavigation: false}});

it('opens and activates independent browser targets with ready metadata and replays changes since each baseline', async () => {
    const runtime = await fixture(), first = await openApplicationView(runtime, {preload: true}), second = await openApplicationView(runtime, {preload: true});
    closes.push(() => first.close(), () => second.close());
    const a = await runtime.projects.sessions.create('A', null), b = await runtime.projects.sessions.create('B', null);
    const [one, two] = await Promise.all([first.backend.openView(request(a)), second.backend.openView(request(b))]);
    expect(one.initial).toMatchObject({sessionId: a, taskAttachment: {pendingTaskIds: []}, flowInvocations: []});
    expect(two.initial?.snapshot.sessionId).toBe(b); expect(one.initial?.skills).toEqual([]);
    await runtime.sessionRepository.updateManifest(a, {title: 'Renamed'});
    const events: ApplicationViewEvent[] = [], stop = await one.observation.observeView(one.cursor, event => events.push(event));
    expect(events.some(event => event.topic === 'repository' && event.value?.sessionId === a)).toBe(true);
    expect(events[0].sequence).toBe(one.cursor + 1); stop();
    await one.dispose(); expect(second.services.sessionManager.getSnapshot().sessionId).toBe(b);
    await expect(first.backend.openView(request(b))).rejects.toMatchObject({code: 'EBUSY'});
});

it('rejects concurrent cold opens and releases a failed initial activation so it can be retried', async () => {
    const runtime = await fixture(), services = bindLocalApplicationServices(runtime), client = createApplicationClient(services);
    closes.push(() => client.close());
    const id = await runtime.projects.sessions.create('Retry', null), execute = services.commandBus.execute.bind(services.commandBus);
    const spy = vi.spyOn(services.commandBus, 'execute').mockImplementation(async (name, args) => {
        if (name === FlowInvocationCommand.List) throw new Error('Presentation read failed');
        return execute(name, args);
    });
    const failed = expect(client.backend.openView(request(id))).rejects.toThrow('Presentation read failed');
    await expect(client.backend.openView(request(id))).rejects.toMatchObject({code: 'EBUSY'}); await failed;
    expect(services.sessionManager.getSnapshot().sessionId).not.toBe(id);
    spy.mockRestore(); const retried = await client.backend.openView(request(id));
    expect(retried.initial?.sessionId).toBe(id); await retried.dispose();
});

it('releases prepared files immediately when later configuration preparation fails', async () => {
    const runtime = await fixture(), services = bindLocalApplicationServices(runtime), client = createApplicationClient(services, {preload: true});
    closes.push(() => client.close());
    const id = await runtime.projects.sessions.create('Configuration failure', null);
    const acquire = services.sessionFiles.acquireFiles.bind(services.sessionFiles), released = vi.fn();
    vi.spyOn(services.sessionFiles, 'acquireFiles').mockImplementation(async sessionId => {
        const owner = await acquire(sessionId);
        return {...owner, release: async () => {released(); await owner.release();}};
    });
    vi.spyOn(services.agentService, 'getConnections').mockRejectedValue(new Error('Configuration unavailable'));
    await expect(client.backend.openView(request(id))).rejects.toThrow('Configuration unavailable');
    expect(released).toHaveBeenCalledOnce();
    expect(services.sessionManager.getSnapshot().sessionId).not.toBe(id);
});

import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend, createVFS} from '@itookit/vfs-core';
import {UserEventService} from '../../../backend/app-core/src/events/service';
import {projectKernelEvents} from '../../../backend/app-core/src/events/kernel-source';
import {ApplicationEventFeed} from '@itookit/app-transport/application';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), service = await UserEventService.open(fs);
    return {fs, service};
}
it('gives two browser feeds independent cursors and a shared persistent notification read state', async () => {
    const {fs, service} = await fixture(), other = await fixture(), baseline = await service.eventBaseline();
    const a = vi.fn(), b = vi.fn(), failure = vi.fn(), reset = vi.fn();
    const first = new ApplicationEventFeed(service, baseline, {receive: a, failure, reset});
    const second = new ApplicationEventFeed(service, baseline, {receive: b, failure, reset});
    await first.start(); await second.start(); cleanup.push(async () => {first.close(); second.close();});
    await service.journal.append('finished', {type: 'task.failed', resourceId: 'task', notification: 'error'});
    await first.refresh(); await second.refresh();
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
    first.close();
    await service.setNotificationRead('finished', true);
    const restored = await UserEventService.open(fs);
    expect((await restored.listNotifications()).items[0]).toMatchObject({read: true});
    expect((await other.service.listNotifications()).items).toEqual([]);
    expect((await other.service.eventBaseline()).streamId).not.toBe(baseline.streamId);
    await expect(other.service.setNotificationRead('finished', true)).rejects.toMatchObject({code: 'ENOENT'});
    expect(failure).not.toHaveBeenCalled();
});
it('recovers missed Kernel facts from durable source and atomically advances its own checkpoint', async () => {
    const {fs, service} = await fixture();
    let fail = true;
    const source = {readEvents: vi.fn(async () => {
        if (fail) throw Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'});
        return {items: [{type: 'task.failed', sessionId: 's', taskId: 't', sequence: 1, occurredAt: 100,
            payload: {secret: 'PRIVATE_BODY'}}], throughSequence: 1};
    })};
    const kernel = {inspectSession: async () => source} as never;
    await expect(projectKernelEvents(service, kernel, 's')).rejects.toMatchObject({code: 'EIO'});
    expect(await service.journal.transaction(tx => tx.getState('kernel/s'))).toBeNull();
    fail = false; await projectKernelEvents(service, kernel, 's');
    const restored = await UserEventService.open(fs);
    source.readEvents.mockImplementation(async () => ({items: [], throughSequence: 1}));
    await projectKernelEvents(restored, kernel, 's');
    expect((await restored.readEvents()).events).toHaveLength(1);
    expect(JSON.stringify(await restored.readEvents())).not.toContain('PRIVATE_BODY');
    expect(await restored.journal.transaction(tx => tx.getState('kernel/s'))).toBe('1');
});
it('resets an expired source checkpoint explicitly instead of silently claiming complete history', async () => {
    const {service} = await fixture();
    const kernel = {inspectSession: async () => ({readEvents: async () => {throw {code: 'CURSOR_EXPIRED'};},
        snapshot: async () => ({asOfSequence: 99})})} as never;
    await projectKernelEvents(service, kernel, 's');
    expect((await service.readEvents()).events[0].value).toEqual({type: 'source.reset', resourceId: 's', sourceSequence: 99});
    expect(await service.journal.transaction(tx => tx.getState('kernel/s'))).toBe('99');
});
it('reloads snapshots after cursor expiration and resumes without consuming other browsers progress', async () => {
    const {service} = await fixture(), receive = vi.fn(), reset = vi.fn(), failure = vi.fn();
    const feed = new ApplicationEventFeed(service, {streamId: 'old-storage', sequence: 999}, {receive, reset, failure});
    await feed.start(); cleanup.push(async () => feed.close());
    expect(reset).toHaveBeenCalledOnce();
    await service.journal.append('new', {type: 'file.changed'}); await feed.refresh();
    expect(receive).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
});

it('shares read state across real RPC views while keeping publication and storage host-only', async () => {
    const {createApplicationRuntime} = await import('@itookit/app-core');
    const {createHostedView} = await import('@itookit/node-host/http');
    const {RpcPeer, installViewProjections} = await import('@itookit/app-transport/application');
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const connect = async () => {
        const view = await createHostedView(runtime); cleanup.push(() => view.close());
        let server!: InstanceType<typeof RpcPeer>;
        const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
        server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, console.error,
            undefined, domains => view.prepare(server, domains));
        cleanup.push(() => client.close(), () => server.close());
        const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
        return {root, client};
    };
    const a = await connect(), b = await connect(), changed = vi.fn();
    expect(a.root.services.events).toBeUndefined();
    expect(a.root.backend.events.journal).toBeUndefined(); expect(a.root.backend.events.append).toBeUndefined();
    const stop = b.root.backend.events.onChange(changed); await b.client.whenIdle();
    await runtime.events.journal.append('rpc-notice', {type: 'task.failed', notification: 'error'});
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    const count = changed.mock.calls.length;
    await a.root.backend.events.setNotificationRead('rpc-notice', true);
    await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(count));
    expect((await b.root.backend.events.listNotifications()).items[0].read).toBe(true);
    stop(); await b.client.whenIdle();
});

it('keeps the browser cursor before a failed callback so a later refresh can retry processing', async () => {
    const {service} = await fixture(), baseline = await service.eventBaseline();
    const receive = vi.fn().mockRejectedValueOnce(new Error('consumer failure')).mockResolvedValue(undefined), failure = vi.fn();
    const feed = new ApplicationEventFeed(service, baseline, {receive, reset() {}, failure});
    await feed.start(); cleanup.push(async () => feed.close());
    await service.journal.append('retry', {type: 'file.changed'});
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(feed.getCursor()).toEqual(baseline);
    await feed.refresh(); expect(receive).toHaveBeenCalledTimes(2);
    expect(feed.getCursor().sequence).toBe(baseline.sequence + 1);
});

it('logs a classified projection write failure with correlation metadata and no exception body', async () => {
    const {attachRuntimeEvents} = await import('../../../backend/app-core/src/events/runtime-events');
    const {service, fs} = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let change!: () => void;
    const sources = {kernel: {kernel: {onChanged: () => () => {}, async *listSessions() {}}},
        sessionRepository: {subscribe: (listener: () => void) => {change = listener; return () => {};}}} as never;
    const projection = await attachRuntimeEvents(service, sources, fs);
    cleanup.push(() => projection.dispose());
    const append = vi.spyOn(service.journal, 'append').mockRejectedValue(Object.assign(new Error('PRIVATE_BODY'), {code: 'ENOSPC'}));
    try {
        change(); await projection.flush();
        expect(warn).toHaveBeenCalledWith('[ApplicationEvents]', expect.objectContaining({operation: 'events.project', operationId: expect.any(String),
            stage: 'repository', result: 'failure', code: 'ENOSPC', durationMs: expect.any(Number)}));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_BODY');
    } finally {append.mockRestore(); warn.mockRestore();}
});

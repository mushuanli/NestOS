import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {expect, it, vi} from 'vitest';
import {createApplicationRuntime} from '@itookit/app-core';
import {MemoryBackend} from '@itookit/vfs-core';
import {SessionCommand} from '../../../backend/llm-session/src/contracts';
import {RpcPeer} from '@itookit/app-transport/application';
import {ViewEventStream} from '../../node-host/src/http/view-event-stream';
import {ViewNotifications} from '../../node-host/src/http/view-notifications';

it('exports real TaskHandles via openTask and keeps notification refreshes resumable', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli',
        startupMode: 'interactive', digitalTwinAutoStart: false});
    const view = await runtime.createView(), report = vi.fn();
    const server = new RpcPeer('server', async () => ({value: null}), report);
    const client = new RpcPeer('client', call => server.handle(call), report);
    const journal = new ViewEventStream();
    const stream = Object.assign(new EventEmitter(), {write: vi.fn(), end: vi.fn(), writableLength: 0});
    journal.attach(stream as unknown as ServerResponse);
    const queue = new ViewNotifications(() => journal, () => server.refresh(), report);
    try {
        const sessionId = await runtime.sessionRepository.createSession('RPC task');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId});
        const kernel = runtime.kernel.kernel;
        kernel.programs.register({manifest: {kind: 'rpc-task-fixture', version: '1'},
            init: input => ({state: null, next: {type: 'complete', output: input}}),
            reduce: () => ({state: null, next: {type: 'complete', output: null}})});
        const task = await (await kernel.openSession(sessionId)).submit({
            program: {kind: 'rpc-task-fixture', version: '1'}, input: null, deferStart: true});
        const local = await kernel.openTask(task.id), snapshot = vi.spyOn(local, 'snapshot');
        expect(await server.expose(local)).toMatchObject({$capability: {kind: 'TaskHandle'}});
        const boot = await server.bootstrap(kernel); client.applyUpdates(boot.updates);
        const remote = client.decode(boot.value!), handle = await remote.openTask(task.id);
        expect(handle.id).toBe(task.id);
        expect(handle.snapshot).toBeUndefined();
        expect(await handle.status()).toMatchObject({task: {id: task.id, status: 'created'}});
        queue.enqueueView({sequence: 1, topic: 'files', value: undefined});
        await vi.waitFor(() => expect(stream.write).toHaveBeenCalled());
        queue.enqueueView({sequence: 2, topic: 'files', value: undefined});
        await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(2));
        expect(journal.destroyed).toBe(false); expect(journal.canResume(1)).toBe(true);
        expect(report).not.toHaveBeenCalled(); expect(stream.end).not.toHaveBeenCalled();
        expect(snapshot).not.toHaveBeenCalled();
        expect(await handle.status()).toMatchObject({task: {id: task.id, status: 'created'}});
    } finally {
        queue.close(); journal.end(); await client.close(); await server.close(); await view.dispose(); await runtime.dispose();
    }
}, 15000);

it('preserves subscribed conversation snapshots and identifies snapshot encoding failures', async () => {
    let changed: (() => void) | undefined, text = 'before';
    const stop = vi.fn(), report = vi.fn();
    const source = {kind: 'fixture', snapshot: () => ({text}), respond: async () => ({}),
        subscribe: (listener: () => void) => {changed = listener; return stop;}};
    const server = new RpcPeer('server', async () => ({value: null}), report);
    const client = new RpcPeer('client', call => server.handle(call), report);
    try {
        const boot = await server.bootstrap(source); client.applyUpdates(boot.updates);
        expect(boot.updates).toEqual(expect.arrayContaining([expect.objectContaining({
            $capability: expect.objectContaining({kind: 'HarnessConversationPort'}),
        })]));
        const remote = client.decode(boot.value!); expect(remote.snapshot()).toEqual({text: 'before'});
        text = 'after'; changed!(); client.applyUpdates(await server.refresh());
        expect(remote.snapshot()).toEqual({text: 'after'});
        source.snapshot = () => Promise.resolve({text}) as unknown as {text: string}; changed!();
        await expect(server.refresh()).rejects.toMatchObject({code: 'ECAPABILITY', operation: 'HarnessConversationPort.snapshot',
            cause: expect.objectContaining({message: expect.stringContaining('Promise')})});
    } finally {await client.close(); await server.close();}
    expect(stop).toHaveBeenCalledOnce();
});

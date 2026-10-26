import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {RpcPeer} from '@itookit/app-transport/application';
import {ContentTransferCommand, SessionCommand, type ChildCreationReceipt, type ICommandBus} from '@itookit/llm-session/contracts';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
it('reads original child creation facts over RPC while the creation response is suspended', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const parent = await runtime.sessionRepository.createSession('Parent');
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: parent});
    const input = {sessionId: parent, requestId: 'original', title: 'Child'};
    let release!: () => void, accepted = false, server!: RpcPeer;
    const suspended = new Promise<void>(done => {release = done;}), observed: Array<{name: string; query: boolean}> = [];
    const client = new RpcPeer('client', call => {observed.push({name: String(call.args[0]), query: server.query(call)}); return server.handle(call);});
    server = new RpcPeer('server', call => client.handle(call));
    const exposed = {list: () => runtime.commandBus.list(), execute: async (name: string, value: unknown) => {
        const result = await runtime.commandBus.execute(name, value);
        if (name === ContentTransferCommand.CreateChild) {accepted = true; await suspended;}
        return result;
    }};
    const bus = client.decode(await server.expose(exposed)) as ICommandBus;
    const pending = bus.execute<{sessionId: string}>(ContentTransferCommand.CreateChild, input);
    try {
        await vi.waitFor(() => expect(accepted).toBe(true));
        const receipt = await bus.execute<ChildCreationReceipt>(ContentTransferCommand.ChildReceipt, input);
        expect(receipt).toMatchObject({parentSessionId: parent, requestId: 'original', status: 'created'});
        expect(observed).toContainEqual({name: ContentTransferCommand.ChildReceipt, query: true});
        await expect(bus.execute(ContentTransferCommand.ChildReceipt, {...input, title: 'Other'})).rejects.toMatchObject({code: 'CONTENT_CHILD_REQUEST_CONFLICT'});
        release(); expect((await pending).sessionId).toBe('sessionId' in receipt ? receipt.sessionId : undefined);
    } finally {release(); await pending; await client.close(); await server.close();}
}, 15000);

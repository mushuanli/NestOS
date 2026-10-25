import {expect, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/rpc';
import {CAPABILITIES} from '@itookit/app-transport/application';
import {observeConversation} from '../../../backend/app-core/src/projects/conversation-view';

it('accepts and edits a native queue through RPC while the original send reply is pending', async () => {
    let server!: RpcPeer, finish!: () => void;
    const errors = vi.fn(), state = {messages: [], requests: []};
    const send = vi.fn(async () => {await new Promise<void>(resolve => {finish = resolve;}); return state;});
    const enqueue = vi.fn(async () => state), editInstructionQueue = vi.fn(async () => state);
    const source = observeConversation({snapshot: () => state, send, enqueue, editInstructionQueue,
        subscribe: () => () => {}, refresh: async () => state,
        respond: async () => {}, close: async () => {finish?.();}} as never);
    const client = new RpcPeer('client', call => server.handle(call), errors, undefined, undefined, CAPABILITIES);
    server = new RpcPeer('server', call => client.handle(call), errors, undefined, undefined, CAPABILITIES);
    try {
        const initial = await server.bootstrap(source); client.applyUpdates(initial.updates);
        const remote = client.decode(initial.value!); const sending = remote.send('First');
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        await remote.enqueue('Second', {submissionId: 'next'});
        await remote.editInstructionQueue({action: 'pause', expectedRevision: 1});
        expect(enqueue).toHaveBeenCalledWith('Second', {submissionId: 'next'});
        expect(editInstructionQueue).toHaveBeenCalledWith({action: 'pause', expectedRevision: 1});
        editInstructionQueue.mockRejectedValueOnce(Object.assign(new Error('Queue revision changed'), {code: 'ECONFLICT'}));
        await expect(remote.editInstructionQueue({action: 'pause', expectedRevision: 0})).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(editInstructionQueue).toHaveBeenCalledTimes(2); expect(errors).not.toHaveBeenCalled();
        finish(); await sending;
    } finally {finish?.(); await source.close(); await client.close(); await server.close();}
});

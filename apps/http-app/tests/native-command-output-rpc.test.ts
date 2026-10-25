import {createHash} from 'node:crypto';
import {expect, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import {observeConversation} from '../../../backend/app-core/src/projects/conversation-view';
import type {HarnessConversationPort} from '@itookit/mindos-node-driver';

it('reads command output independently through the real application RPC while a send reply is suspended', async () => {
    let server!: RpcPeer, release!: (value: unknown) => void;
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    const ref = {version: 1 as const, epoch: 'e', requestId: 'original-operation', bytes: 3, sha256: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), mimeType: 'text/plain' as const};
    const state = {kind: 'fixture', sessionId: 's', title: 'Original', draft: 'new unsent draft', messages: [{id: 'command:c', role: 'system', text: 'preview', status: 'completed',
        commandOutput: {commandId: 'c', ref, truncated: true}}], requests: [], canSend: true, canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false};
    const source = {kind: 'fixture', snapshot: () => state, subscribe: () => () => {}, read: async () => state, refresh: vi.fn(async () => state),
        send: vi.fn(() => new Promise(resolve => {release = resolve;})), respond: async () => state, close: async () => {},
        readCommandOutput: vi.fn(async (_id: string, options?: {offset?: number; limit?: number}) => ({ref, offset: options?.offset ?? 0, data: 'AQID', nextOffset: null})),
        loadCommandOutput: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)};
    const controls = observeConversation(source as unknown as HarnessConversationPort), peer = client.decode(await server.expose(controls)) as typeof controls;
    let send: Promise<unknown> | undefined;
    try {
        const finished = vi.fn();
        send = peer.send('pending send'); void send.then(finished, finished); await vi.waitFor(() => expect(source.send).toHaveBeenCalledOnce());
        expect(new Uint8Array(await peer.loadCommandOutput!('c', {maxBytes: 100}))).toEqual(new Uint8Array([1, 2, 3]));
        expect(await peer.readCommandOutput!('c', {offset: 0, limit: 3})).toEqual({ref, offset: 0, data: 'AQID', nextOffset: null});
        expect(source.loadCommandOutput).toHaveBeenCalledWith('c', {maxBytes: 100});
        expect(source.readCommandOutput).toHaveBeenCalledWith('c', {offset: 0, limit: 3});
        expect(finished).not.toHaveBeenCalled();
        source.loadCommandOutput.mockRejectedValueOnce(Object.assign(new Error('Output access denied'), {code: 'EACCES'}));
        await expect(peer.loadCommandOutput!('c')).rejects.toMatchObject({code: 'EACCES'});
        source.readCommandOutput.mockRejectedValueOnce(Object.assign(new Error('Output expired'), {code: 'ENOENT'}));
        await expect(peer.readCommandOutput!('c', {offset: 0, limit: 3})).rejects.toMatchObject({code: 'ENOENT'});
        expect(finished).not.toHaveBeenCalled();
        expect((await peer.read()).messages[0]).toMatchObject({status: 'completed', commandOutput: {commandId: 'c', ref}});
        expect((await peer.read()).draft).toBe('new unsent draft'); expect(source.send).toHaveBeenCalledOnce(); expect(source.refresh).not.toHaveBeenCalled();
    } finally {release?.(state); await send?.catch(() => {}); await controls.close(); await client.close(); await server.close();}
});

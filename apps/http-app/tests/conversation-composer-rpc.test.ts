import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {RpcPeer} from '@itookit/app-transport/application';
import {ConversationComposerStore} from '../../../backend/app-core/src/projects/conversation-composer-store';

it('carries composer originals, conditional updates and receipt queries through application RPC', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), error => {throw error;});
    server = new RpcPeer('server', call => client.handle(call), error => {throw error;});
    try {
        const fs = await manager.openFileSystem('/'), store = new ConversationComposerStore(fs, 'project', 'conversation', true, () => {});
        const controls = {kind: 'fixture', snapshot: () => ({title: 'Fixture', messages: [], requests: []}), respond: async () => {},
            readComposerDraft: () => store.readComposerDraft(), saveComposerDraft: store.saveComposerDraft.bind(store),
            putComposerAsset: store.putComposerAsset.bind(store), readComposerAsset: store.readComposerAsset.bind(store)};
        const peer = client.decode(await server.expose(controls)) as typeof controls;
        const bytes = new Uint8Array([4, 3, 2, 1]), id = await peer.putComposerAsset(bytes.buffer);
        expect(new Uint8Array(await peer.readComposerAsset(id))).toEqual(bytes);
        const next = await peer.saveComposerDraft('{"original":"asset","crop":"rect"}', '0', 'rpc-save');
        expect(await peer.readComposerDraft()).toEqual(next);
        await expect(peer.saveComposerDraft('stale', '0', 'stale')).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(await peer.saveComposerDraft('duplicate', '0', 'rpc-save')).toEqual(next);
    } finally {await client.close(); await server.close(); await manager.dispose();}
});

import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {HarnessInstructionQueue} from '@itookit/nestos-node-driver';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';

it('refuses stale, same-revision replacement and deletion of a pending native queue', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new RemoteConversationStore(fs, 'queue');
        const queue: HarnessInstructionQueue = {revision: 2, paused: true, receipts: [],
            items: [{id: 'next', text: 'Next', attachments: [], createdAt: 1, state: 'pending'}]};
        await store.save({instructionQueue: queue});
        for (const instructionQueue of [undefined, {...queue, revision: 1}, {...queue, paused: false}]) {
            await expect(store.save({instructionQueue})).rejects.toMatchObject({code: 'ECONFLICT'});
        }
        expect((await store.load())?.instructionQueue).toEqual(queue);
        await store.save({instructionQueue: {...queue, revision: 3, paused: false}});
        expect((await new RemoteConversationStore(fs, 'queue').load())?.instructionQueue)
            .toEqual({...queue, revision: 3, paused: false});
    } finally {await manager.dispose();}
});

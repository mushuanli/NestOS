import {expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createVFS} from '@itookit/vfs-core';
import {openLocalFSBackend} from '@itookit/vfsdriver-local';
import {NodeSqliteSidecarDb} from '@itookit/node-host/storage';
import {RemoteConversationStore} from '../../../backend/app-core/src/projects/remote-conversation-store';
import {recoverRemoteConversationQueues} from '../../../backend/app-core/src/projects/remote-conversation-recovery';

async function openUser(directory: string, userId: string) {
    const home = path.join(directory, userId, '.nestos');
    const backend = await openLocalFSBackend({rootDir: path.join(home, 'state'), sidecarDir: path.join(home, 'meta'),
        durability: 'full', createDb: NodeSqliteSidecarDb.open});
    const {manager} = await createVFS({rootBackend: backend}), fs = await manager.openFileSystem('/');
    const store = new RemoteConversationStore(fs, JSON.stringify(['project', 'connection', 'export', 'codex', 'native']));
    return {fs, store, close: async () => {await manager.dispose(); await backend.close();}};
}

it('restores both users durable queue facts after closing and reopening their physical home bundles', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-queue-restart-'));
    try {
        for (const userId of ['alice', 'bob']) {
            const user = await openUser(directory, userId);
            try {await user.store.load(); await user.store.save({sessionId: 'native', instructionQueue: {revision: 4, paused: false,
                receipts: [{id: userId, input: 'a'.repeat(64), turnId: 'turn'}], items: [{id: userId, text: `Private ${userId}`, attachments: [],
                    state: 'dispatching', createdAt: Date.now(), receipt: {turnId: 'turn'}, terminal: {turnId: 'turn', result: 'completed', observedAt: Date.now()}}]}});}
            finally {await user.close();}
        }
        for (const userId of ['alice', 'bob']) {
            const user = await openUser(directory, userId), read = vi.fn(async () => {});
            try {
                expect((await user.store.load())?.instructionQueue?.items[0]).toMatchObject({id: userId, terminal: {turnId: 'turn', result: 'completed'}});
                const result = await recoverRemoteConversationQueues(user.fs, async () => ({read, snapshot: () => ({instructionQueue: {items: [userId]}}), close: vi.fn()}) as never);
                expect(result).toEqual({recovered: 1, deferred: 0}); expect(read).toHaveBeenCalledOnce();
            } finally {await user.close();}
        }
    } finally {await rm(directory, {recursive: true, force: true});}
});

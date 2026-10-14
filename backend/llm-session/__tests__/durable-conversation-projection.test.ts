import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kernel, type SessionHandle } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { DurableConversationProjection } from '../src/persistence/durable-conversation-projection';
import type { ConversationManifest, ISessionRepository } from '../src/persistence/types';

describe('DurableConversationProjection', () => {
    let manager: IVFSManager;
    let kernel: Kernel;
    let fs: IFileSystem;
    let session: SessionHandle;
    let manifest: ConversationManifest;

    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend(),}));
        fs = await manager.openFileSystem('/module/test');
        kernel = new Kernel({ catalog: { fs } });
        kernel.registerStorageResolver({
            kind: 'test',
            async resolve() { return { fs, rootPath: '/sessions/one/.kernel' }; },
        });
        await kernel.initialize();
        session = await kernel.createSession({ id: 'session-one', storage: { kind: 'test', locator: null } });
        manifest = createManifest();
    });

    afterEach(async () => { await kernel.dispose(); await manager.dispose(); });

    it('persists only changed conversation manifest revisions', async () => {
        const engine = { getManifest: async () => manifest } as unknown as ISessionRepository;
        const projection = new DurableConversationProjection(engine);
        await projection.sync(session, '/chat/session.chat');
        await projection.sync(session, '/chat/session.chat');
        manifest = { ...manifest, currentHead: 'round-1', branches: { main: 'round-1' } };
        await projection.sync(session, '/chat/session.chat');

        expect((await session.getShared('conversation/manifest'))?.value).toMatchObject({ currentHead: 'round-1' });
        expect(await session.sharedHistory('conversation/manifest')).toHaveLength(2);
    });

    it('reuses a caller-read manifest instead of reading the Session record again', async () => {
        let reads = 0;
        const engine = { getManifest: async () => { reads++; return manifest; } } as unknown as ISessionRepository;
        const projection = new DurableConversationProjection(engine);
        // A bind passes the manifest it just loaded, so the projection must not re-read it.
        await projection.sync(session, '/chat/session.chat', undefined, manifest);
        expect(reads).toBe(0);
        // Event-driven syncs have no fresh manifest and must read the current one.
        await projection.sync(session, '/chat/session.chat');
        expect(reads).toBe(1);
    });

    it('reads the manifest and runtime from one snapshot when the handle supports it', async () => {
        const getSharedMany = vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, undefined])));
        const getShared = vi.fn(async () => undefined);
        const setShared = vi.fn(async () => ({}));
        const handle = { id: 's', getShared, getSharedMany, setShared } as unknown as SessionHandle;
        const engine = { getManifest: async () => manifest } as unknown as ISessionRepository;
        const projection = new DurableConversationProjection(engine);
        await projection.sync(handle, '/chat/session.chat', { sessionId: 's', status: 'idle', unreadCount: 0, lastActiveTime: 1 });
        expect(getSharedMany).toHaveBeenCalledTimes(1);
        expect(getSharedMany.mock.calls[0][0]).toEqual(['conversation/manifest', 'conversation/runtime']);
        // Both values were written because the snapshot reported neither key as stored yet.
        expect(setShared.mock.calls.map(([key]) => key)).toEqual(['conversation/manifest', 'conversation/runtime']);
        expect(getShared).not.toHaveBeenCalled();
    });
});

function createManifest(): ConversationManifest {
    return {
        id: 'session-one', title: 'Session', schemaVersion: 3,
        rootRoundId: null, branches: { main: null }, branchMeta: {},
        currentBranch: 'main', currentHead: null, children: {},
        createdAt: 1, updatedAt: 1,
    };
}

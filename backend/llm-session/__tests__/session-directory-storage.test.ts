import { afterEach, describe, expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionDirectoryStorageResolver, sessionDirectoryStorage } from '../src/persistence/session-directory-storage';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('Session directory storage', () => {
    it('binds by Session identity without a conversation file and rejects old storage kinds', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        cleanup.push(() => manager.dispose());
        const fs = await manager.openFileSystem('/');
        const resolver = new SessionDirectoryStorageResolver(fs);
        expect((await resolver.resolve(sessionDirectoryStorage('headless'))).rootPath).toBe('/var/lib/sessions/headless/kernel');
        expect(() => sessionDirectoryStorage('../escape')).toThrow();
        await expect(resolver.resolve({ kind: 'chat-asset', locator: { sessionId: 'headless' } })).rejects.toThrow('Unsupported');
    });
});

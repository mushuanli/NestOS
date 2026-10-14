import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { LocalFileLocal, LocalSyncStore, LocalSyncCoordinator } from '../../src/local';
import type { FileAction } from '@itookit/vfs-sync';
const options = JSON.parse(process.argv[2]);
const backend = await openLocalFSBackend(options), store = new LocalSyncStore(backend.storageAccess(), 'b');
const saved = (await store.plan<{ token: string; handle: unknown; actions: FileAction[] }>('crash-input'))!;
const coordinator = new LocalSyncCoordinator(backend.storageAccess());
await coordinator.exclusive('b', async guard => {
    const scoped = store.scoped(guard!);
    scoped.save = async (db, state) => {
        if (state.baseline.some(entry => entry.path === 'a')) process.kill(process.pid, 'SIGKILL');
        await LocalSyncStore.prototype.save.call(scoped, db, state);
    };
    await new LocalFileLocal(scoped).apply(saved.token, saved.handle, saved.actions, 'crash');
});
throw new Error('crash point was not reached');

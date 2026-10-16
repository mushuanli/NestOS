import { once } from 'node:events';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { Kernel } from '@itookit/durable-kernel';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { acquireSchedulerLease } from '../../../../backend/llm-flow/src/flow/scheduler-lease';

const [root, role] = process.argv.slice(2);
const backend = await openLocalFSBackend({ rootDir: `${root}/state`, sidecarDir: `${root}/meta`, createDb: NodeSqliteSidecarDb.open });
const { manager } = await createVFS({ rootBackend: backend });
const fs = await manager.openFileSystem('/');
const kernel = new Kernel({ catalog: { fs }, maxConcurrent: 0 });
kernel.registerStorageResolver({ kind: 'local', resolve: async () => ({ fs, rootPath: '/session' }) });
await kernel.initialize();
const session = role === 'owner' ? await kernel.createSession({ id: 's', storage: { kind: 'local', locator: null } }) : await kernel.openSession('s');
const task = role === 'owner'
    ? await session.submit({ program: { kind: 'idle', version: '1' }, input: null, deferStart: true })
    : await session.attachTask((await session.listTasks())[0].id);
const lease = await acquireSchedulerLease(session, task.id, { ownerId: role, ttlMs: 1000 });
try {
    if (role === 'owner') {
        // Suspend after startup writes drain so this exercises lease fencing,
        // not a process frozen while holding SQLite's writer lock.
        await kernel.waitIdle();
        process.send?.({ phase: 'ready', taskId: task.id });
        process.kill(process.pid, 'SIGSTOP');
        await once(process, 'message');
        const guard = { lease: lease.condition };
        const actions = [() => task.cancel('stale', guard), () => task.pause({ ...guard, requestId: 'stale-pause' }), () => task.resume({ ...guard, requestId: 'stale-resume' }),
            () => task.start(guard), () => task.signal({ type: 'stale' }, guard),
            () => task.retry({ requestId: 'stale', ...guard }),
            () => kernel.createResource('s', { kind: 'llm', uri: 'llm://stale', ownerTaskId: task.id }, guard),
            () => session.setShared('late-write', true, guard)];
        const results = [];
        for (const action of actions) {
            try { await action(); results.push('accepted'); }
            catch (error) { results.push((error as { code?: string }).code ?? String(error)); }
        }
        await lease.release();
        process.send?.({ phase: 'checked', results });
    } else {
        process.send?.({ phase: 'taken', epoch: lease.epoch });
        await once(process, 'message');
        await lease.assertOwned();
        process.send?.({ phase: 'verified', tasks: await session.listTasks(), late: await session.getShared('late-write') });
    }
} finally {
    await lease.release(); kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); process.disconnect?.();
}

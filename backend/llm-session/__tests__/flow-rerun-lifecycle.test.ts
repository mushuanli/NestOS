import { expect, it } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRunCoordinator } from '../src/session/session-run-coordinator';

it('admits an explicit Flow rerun after close without resuming the previous Task', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session' }; } });
    await kernel.initialize();
    const session = await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    const runs = new SessionRunCoordinator({} as never, {} as never, {} as never, {} as never,
        {} as never, kernel, {} as never, {} as never);
    try {
        const previous = await session.spawn({ program: { kind: 'test', version: '1' }, input: 'old' });
        await kernel.closeSession('s', true);
        await expect(runs.assertCanSubmit('s')).rejects.toThrow();
        expect((await kernel.sessionStat('s')).phase).toBe('closed');
        await runs.assertCanSubmit('s', true);
        kernel.registerProgram({ manifest: { kind: 'test', version: '1' },
            init: input => ({ state: null, next: { type: 'complete', output: input } }),
            reduce: () => { throw new Error('Already complete'); } });
        const next = await session.spawn({ program: { kind: 'test', version: '1' }, input: 'new' });
        expect(next.id).not.toBe(previous.id);
        expect((await previous.status()).task.status).toBe('cancelled');
        expect((await next.wait({ timeoutMs: 2000 })).output).toBe('new');
        expect((await previous.status()).task.status).toBe('cancelled');
        await kernel.closeSession('s', true);
        await kernel.setSessionStatus('s', 'archived');
        await expect(runs.assertCanSubmit('s', true)).rejects.toThrow();
        expect((await kernel.sessionStat('s')).archived).toBe(true);
    } finally { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); }
});

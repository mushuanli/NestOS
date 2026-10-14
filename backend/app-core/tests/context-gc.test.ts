import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IDeviceDriver } from '@itookit/vfs-core';
import { bindCapabilities } from '@itookit/durable-kernel';
import { createTaskContextStorage } from '@itookit/kernel-adapters';
import { createContextService } from '@itookit/llm-context';
import { createKernelRuntime, type HeadlessKernelRuntime } from '../src/runtime/create-kernel-runtime';

async function close(runtime: HeadlessKernelRuntime) {
    runtime.kernel.dispose(); await runtime.kernel.waitIdle(); await runtime.dispose();
}

it('observes one Session without enumerating the catalog', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const runtime = await createKernelRuntime({ systemFS: fs,
        storageResolver: { kind: 'test', resolve: async reference =>
            ({ fs, rootPath: (reference.locator as { rootPath: string }).rootPath }) },
        llmDriver: {} as unknown as IDeviceDriver, recover: false,
        contextGc: { initialDelayMs: 60_000, intervalMs: 60_000 } });
    try {
        for (const id of ['one', 'two', 'three']) {
            await runtime.kernel.createSession({ id, storage: { kind: 'test', locator: { rootPath: `/sessions/${id}/.kernel` } } });
        }
        const list = vi.spyOn(runtime.kernel, 'listSessions');
        const inspect = vi.spyOn(runtime.kernel, 'inspectSession');
        await runtime.contextGc!.observeSession('two');
        expect(list).not.toHaveBeenCalled();
        expect(inspect).toHaveBeenCalledTimes(1);
        // A caller that already holds the catalog reference costs no extra read.
        await runtime.contextGc!.observeSession('three', { kind: 'test', locator: { rootPath: '/sessions/three/.kernel' } });
        expect(inspect).toHaveBeenCalledTimes(1);
    } finally { await close(runtime); await manager.dispose(); }
});

it('automatically collects after restart, respects ownership loss, and retains committed history', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const options = { systemFS: fs,
        storageResolver: { kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) },
        llmDriver: { ioctl: async () => ({ id: 'r', model: 'test', choices: [{ index: 0,
            message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }) } as unknown as IDeviceDriver };
    let runtime = await createKernelRuntime({ ...options, recover: false, contextGc: false });
    try {
        const session = await runtime.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        const task = await session.submit({ program: { kind: 'llm.chat', version: '2' }, deferStart: true,
            input: { sessionId: 's', roundId: 'r', connectionId: 'default', stream: false, messages: [{ role: 'user', content: 'goal' }] } });
        const content = createTaskContextStorage(fs, '/session', task.id).content;
        const orphan = await content.publish('orphan after crash', 'text/plain');
        await bindCapabilities(task, [{ kind: 'llm', uri: 'llm://default', rights: ['execute', 'write'], signalKey: 'llmHandleId' }]);
        expect((await task.wait({ timeoutMs: 5000 })).status).toBe('succeeded');
        await close(runtime);
        let owned = false;
        const onResult = vi.fn();
        runtime = await createKernelRuntime({ ...options, contextGc: { initialDelayMs: 10, intervalMs: 10,
            policy: { retentionMs: 0 }, canCollectSession: () => owned, onResult } });
        expect(await runtime.contextGc!.collect()).toEqual([]);
        expect(await content.read(orphan)).toBe('orphan after crash');
        owned = true;
        await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, deleted: 1 })), { timeout: 3000 });
        await expect(content.read(orphan)).rejects.toThrow('missing or corrupt');
        const restored = await runtime.kernel.openSession('s');
        const reader = createContextService({ content, records: { get: async key => (await restored.getShared(key))?.value } });
        expect((await reader.history(task.id, { query: 'done' })).items).toHaveLength(1);
        await runtime.kernel.closeSession('s');
        expect(await runtime.contextGc!.collect()).toEqual([]);
        await runtime.kernel.removeSession('s');
        const remaining: string[] = [];
        await fs.meta.seq!.transaction!(tx => tx.walkEntries(`/session/tasks/${task.id}/task.seq`, row => {
            remaining.push(row.key); return true;
        }, { keyPrefix: 'context-content/' }));
        expect(remaining).toEqual([]);
        await runtime.contextGc!.dispose();
        const count = onResult.mock.calls.length;
        expect(await runtime.contextGc!.collect()).toEqual([]);
        expect(onResult).toHaveBeenCalledTimes(count);
    } finally { await close(runtime); await manager.dispose(); }
});

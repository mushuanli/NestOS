import { expect, it, vi } from 'vitest';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IDeviceDriver } from '@itookit/vfs-core';
import { createKernelRuntime } from '../src/runtime/create-kernel-runtime';

it('locates media receipts by Session identity without enumerating other Sessions', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const runtime = await createKernelRuntime({ systemFS: fs, recover: false, contextGc: false,
        llmDriver: { ioctl: async () => undefined } as unknown as IDeviceDriver,
        storageResolver: { kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) } });
    try {
        await runtime.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        await fs.driver.createFile({ parentPath: '/session/tasks/t', name: 'task.seq', type: 'seqfile', recursive: true });
        const list = vi.spyOn(runtime.kernel, 'listSessions').mockImplementation(() => { throw new Error('Unexpected enumeration'); });
        const inspect = vi.spyOn(runtime.kernel, 'inspectSession');
        const context: EffectExecutionContext = { sessionId: 's', taskId: 't', effectId: 'e', abortSignal: new AbortController().signal,
            grants: [{ handleId: 'h', right: 'execute', resource: { id: 'r', sessionId: 's', kind: 'llm', uri: 'llm://test', generation: 1, createdAt: 0 } }] };
        const request = { resourceHandleId: 'h', connectionId: 'model', request: { operation: 'image.generate', model: 'image', prompt: 'Square', format: 'png' } };
        const adapter = runtime.kernel.effects.resolve('llm.media', '1');
        expect(await adapter.reconcile!(request, context)).toMatchObject({ status: 'indeterminate' });
        expect(inspect).toHaveBeenCalledWith('s'); expect(list).not.toHaveBeenCalled();
        await expect(adapter.reconcile!(request, { ...context, sessionId: 'missing' })).rejects.toThrow();
    } finally {
        runtime.kernel.dispose(); await runtime.kernel.waitIdle(); await runtime.dispose(); await manager.dispose();
    }
});

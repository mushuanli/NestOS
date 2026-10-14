import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { ExecProgram } from '@itookit/kernel-adapters';
import type { IAgentConfigService } from '@itookit/llm-session';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { PrivilegedCommandService } from '../src/kernel/privileged-command-service';

it.each([true, false])('unified exec submission preserves the approval boundary (approved: %s)', async approved => {
    const fixture = await setup();
    try {
        const service = new PrivilegedCommandService(fixture.kernel, {} as IAgentConfigService);
        const id = await service.exec({ sessionId: 'session', command: 'inspect' });
        const task = await fixture.session.attachTask(id);
        await vi.waitFor(async () => expect((await task.status()).task.interactions['approve:exec']?.status).toBe('pending'));
        expect(fixture.execute).not.toHaveBeenCalled();
        await task.respond({ interactionId: 'approve:exec', value: { approved } });
        expect((await task.wait({ timeoutMs: 2000 })).status).toBe(approved ? 'succeeded' : 'failed');
        expect(fixture.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
        expect(await fixture.kernel.listSessionTasks('session')).toHaveLength(1);
    } finally { await fixture.dispose(); }
});

async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session/.kernel' }; } });
    kernel.registerProgram(new ExecProgram());
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: 'inspected' }));
    kernel.registerEffect({ kind: 'process.exec', version: '1', execute });
    await kernel.initialize();
    const session = await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
    return { kernel, session, execute, async dispose() {
        await kernel.dispose();
        await kernel.waitIdle();
        await manager.dispose();
    } };
}

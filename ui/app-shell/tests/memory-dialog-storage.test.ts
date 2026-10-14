// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { SessionManager, SessionRepository, SessionDirectoryStorageResolver } from '@itookit/llm-session';
import { NodeSqliteSidecarDb } from '../../../apps/cli/src/sqlite-sidecar';
import { showMemoryDialog } from '../src/files/memory-dialog';

async function host(root: string) {
    const backend = await openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'meta'), createDb: NodeSqliteSidecarDb.open });
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs } });
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs)); await kernel.initialize();
    const repository = new SessionRepository(fs); await repository.init();
    const sessions = new SessionManager(repository, { getAgentConfig: async () => ({ id: 'agent',
        memoryPolicy: { namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'] },
    }) } as never, { kernel, dagPlugins: {} as never, flowStore: {} as never, canWriteSession: async () => true });
    return { repository, sessions, close: async () => {
        sessions.destroy(); kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
    } };
}

function button(text: string): HTMLButtonElement {
    return [...document.querySelectorAll('dialog button')].find(item => item.textContent === text) as HTMLButtonElement;
}
async function idle(): Promise<void> {
    await vi.waitFor(() => expect(button(t('memory.manage.save')).disabled).toBe(false));
}
async function click(text: string): Promise<void> { button(text).click(); await idle(); }

it('persists dialog edits and deletion across complete LocalFS/SQLite host reopen', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    const root = await mkdtemp(join(tmpdir(), 'memory-dialog-'));
    let runtime: Awaited<ReturnType<typeof host>> | undefined;
    try {
        runtime = await host(root);
        const sessionId = await runtime.repository.createSession('Memory'); await runtime.sessions.bindSession(sessionId);
        const pinned = runtime.sessions.memory.forSession(sessionId);
        let closed = showMemoryDialog(pinned, [{ id: 'agent', name: 'Agent' }]); await idle();
        const otherSession = await runtime.repository.createSession('Other');
        await runtime.sessions.bindSession(otherSession);
        const inputs = document.querySelectorAll('dialog input'); inputs[0].value = 'project'; inputs[1].value = 'note';
        document.querySelector('textarea')!.value = 'created in dialog'; await click(t('memory.manage.save'));
        expect((await pinned.list('agent'))[0].content).toBe('created in dialog');
        expect(await runtime.sessions.memory.list('agent')).toEqual([]);
        button('project / note').click(); document.querySelector('textarea')!.value = 'edited in dialog';
        await click(t('memory.manage.save')); button(t('memory.manage.close')).click(); await closed;
        await runtime.close(); runtime = undefined;

        runtime = await host(root); await runtime.sessions.bindSession(sessionId);
        const restored = runtime.sessions.memory.forSession(sessionId);
        expect((await restored.list('agent'))[0].content).toBe('edited in dialog');
        closed = showMemoryDialog(restored, [{ id: 'agent', name: 'Agent' }]); await idle(); button('project / note').click();
        expect(document.querySelector('textarea')!.value).toBe('edited in dialog');
        await click(t('memory.manage.delete')); button(t('memory.manage.close')).click(); await closed;
        await runtime.close(); runtime = undefined;
        runtime = await host(root); await runtime.sessions.bindSession(sessionId);
        expect(await runtime.sessions.memory.list('agent')).toEqual([]);
    } finally {
        await runtime?.close(); document.body.replaceChildren(); await rm(root, { recursive: true, force: true });
        if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
        else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    }
});

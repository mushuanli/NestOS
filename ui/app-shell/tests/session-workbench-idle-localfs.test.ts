import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
// P0-02: measure VFS and real SQLite calls while the DOM workbench is idle.
// Logical sidecar counts are not Tauri transport counts; the Kernel facade below is a stub.
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { SessionRepository } from '@itookit/llm-session';
import { SessionFilesService, createSessionAttachmentMounts } from '@itookit/app-core';

function positiveDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
    const delta: Record<string, number> = {};
    for (const [key, value] of Object.entries(after)) {
        if (value - (before[key] ?? 0) > 0) delta[key] = value - (before[key] ?? 0);
    }
    return delta;
}

it('issues no VFS or sidecar operations while the Session workbench is idle on LocalFS', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const root = await mkdtemp(join(tmpdir(), 'mindos-idle-localfs-'));
    const backend = await openLocalFSBackend({
        rootDir: join(root, 'data'), sidecarDir: join(root, 'db'),
    });
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    const id = await repository.createSession('Session title');
    const intrinsic = createSessionAttachmentMounts(repository);
    const files = new SessionFilesService(fs, sid => intrinsic.forSession(sid)); await files.initialize();
    const home = await manager.openFileSystem('/home/admin');
    files.registerSource('home', home); files.registerSource('admin-home', home);
    await files.configure(id, { mounts: [], cwd: '/' }, 0);
    const task = { id: 'task-one', sessionId: id, program: { kind: 'test' }, status: 'succeeded', version: 1, createdAt: 1, updatedAt: 2, output: 'x' };
    const kernel = {
        onChanged: () => () => {}, async *listSessions() { yield { id }; },
        listSessionTasks: async () => [task],
        listSessionTaskPage: vi.fn(async () => ({ items: [task], throughIndex: 1, nextAfterIndex: undefined })),
        task: async () => task, taskHistory: async () => [task],
        taskHistoryPage: vi.fn(async () => ({ items: [task], throughVersion: 1, nextAfterVersion: undefined })),
        taskEventPage: vi.fn(async () => ({ items: [], throughIndex: 0, nextAfterIndex: undefined })),
        eventList: vi.fn(async () => []),
    };
    const sidebar = document.createElement('div'), main = document.createElement('div');
    document.body.append(sidebar, main);
    const chat = vi.fn(async () => ({ destroy: vi.fn() }));
    const file = vi.fn(async () => ({ destroy: vi.fn() }));
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files, factory: chat as never, onSelect: () => {}, hostContext: undefined, kernel: kernel as never, fileFactory: file as never });
    try {
        await workbench.start();
        await workbench.openResource(id);
        // Let the initial render and selection settle before measuring.
        await new Promise(resolve => setTimeout(resolve, 500));

        backend.resetSidecarStats();
        const vfsBefore: Record<string, number> = { ...manager.ioStats };
        const sidecarBefore: Record<string, number> = { ...backend.sidecarStats };
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const vfsDelta = positiveDeltas(vfsBefore, { ...manager.ioStats });
        const sidecarDelta = positiveDeltas(sidecarBefore, { ...backend.sidecarStats });
        expect(sidecarDelta).toEqual({});
        expect(vfsDelta).toEqual({});
    } finally {
        await workbench.destroy();
        await manager.dispose();
        await rm(root, { recursive: true, force: true });
        vi.unstubAllGlobals();
    }
}, 30_000);

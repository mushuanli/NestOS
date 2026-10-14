import { createLocalBackendPort } from '@itookit/app-core/host';
// @vitest-environment jsdom
// Regression guard for the P0-02 idle-traffic investigation: the Session sidebar and
// workbench must not poll the backend while nothing changes. VFS operation counts
// describe logical work, not desktop transport requests.
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { SessionFilesService } from '@itookit/app-core';
import { createSessionAttachmentMounts } from '@itookit/app-core';
import { SessionWorkbench } from '../src/projects/SessionWorkbench';

it('issues no VFS operations while the Session workbench is idle', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const id = await repository.createSession('Session title');
    const intrinsic = createSessionAttachmentMounts(repository);
    const files = new SessionFilesService(root, sid => intrinsic.forSession(sid)); await files.initialize();
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
    const workbench = new SessionWorkbench({ backend: createLocalBackendPort(),  sidebar: sidebar, container: main, repository: repository, files: files, factory: chat as never, onSelect: () => {}, hostContext: undefined, kernel: kernel as never, fileFactory: file as never });
    try {
        await workbench.start();
        await workbench.openResource(id);
        // Let the initial render and selection settle before measuring.
        await new Promise(resolve => setTimeout(resolve, 500));

        const before: Record<string, number> = { ...manager.ioStats };
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const after: Record<string, number> = { ...manager.ioStats };
        const delta: Record<string, number> = {};
        for (const [key, value] of Object.entries(after)) {
            if (value - (before[key] ?? 0) > 0) delta[key] = value - (before[key] ?? 0);
        }
        expect(delta).toEqual({});
    } finally {
        await workbench.destroy();
        await manager.dispose();
        vi.unstubAllGlobals();
    }
}, 30_000);

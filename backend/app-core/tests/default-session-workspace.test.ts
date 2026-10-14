import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

it('awaits default host workspace setup for every new Session and preserves later changes on reopen', async () => {
    const source = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await source.manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'test.txt', content: 'cwd file' });
    const openDirectory = vi.fn(async () => fs);
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'tauri',
        defaultSessionDirectory: 'host:/home/admin/current', directorySourceProvider: {
            selectDirectory: async () => null, openDirectory, dispose: async () => {},
        } });
    try {
        const project = (await runtime.projects.current())!;
        expect(project.project.directory).toBe('host:/home/admin/current');
        expect(project.name).toBe('current');
        const a = await runtime.sessionRepository.createSession('Harness');
        const b = await runtime.sessionRepository.createSession('Flow');
        for (const id of [a, b]) {
            expect((await runtime.sessionRepository.getManifest(id)).folder).toBe(project.path + '/@sessions');
            expect((await runtime.sessionFiles.inspect(id))?.cwd).toBe('/workspace');
            const files = await runtime.sessionFiles.acquire(id);
            try { expect(await files.vfs.readFile('test.txt')).toBe('cwd file'); } finally { await files.release(); }
        }
        expect(openDirectory).toHaveBeenCalledWith('/home/admin/current');
        await expect(runtime.directoryMounts.setWorkspace(a, 'host:/changed', 'ro')).rejects.toMatchObject({ code: 'EACCES' });
        await runtime.sessionRepository.ensureSession(a, 'Reopened');
        const record = (await runtime.sessionFiles.inspect(a))!;
        expect(record.mounts[0].access).toBe('rw');
        expect(runtime.directoryMounts.describe(record.mounts[0])).toBe('/home/admin/current');
        expect(runtime.directoryMounts.describe((await runtime.sessionFiles.inspect(b))!.mounts[0])).toBe('/home/admin/current');
    } finally { await runtime.dispose(); await source.manager.dispose(); }
});

it('uses a VFS project directory as the browser workspace for file harness tools', async () => {
    const backend = new MemoryBackend();
    await backend.init();
    await backend.mkdir('/home/admin/projects/web-project');
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'web',
        defaultSessionDirectory: '/home/admin/projects/web-project' });
    try {
        const id = await runtime.sessionRepository.createSession('Web project');
        const record = await runtime.sessionFiles.inspect(id);
        expect(record?.cwd).toBe('/workspace');
        expect(record?.mounts).toMatchObject([{ at: '/workspace', sourceId: 'admin-home',
            root: '/projects/web-project', access: 'rw' }]);
        const tools = (await runtime.kernel.sessions.get(id)).toolService;
        for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
            expect(tools.getToolMeta(name)?.enabled).toBe(true);
        }
        expect(tools.getToolMeta('Bash')?.enabled).toBe(false);
        expect((await tools.invoke({ toolId: 'Write', args: {
            file_path: 'note.md', content: 'browser workspace',
        } })).success).toBe(true);
        const read = await tools.invoke({ toolId: 'Read', args: { file_path: 'note.md' } });
        expect(read.output).toContain('browser workspace');
        const glob = await tools.invoke({ toolId: 'Glob', args: { pattern: '*.md' } });
        expect(glob.output).toContain('/workspace/note.md');
        const project = await runtime.vfs.openFileSystem('/home/admin/projects/web-project');
        expect(await project.driver.readContent('/note.md', { encoding: 'utf-8' })).toBe('browser workspace');
    } finally { await runtime.dispose(); }
});

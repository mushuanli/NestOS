import { expect, it, vi } from 'vitest';
it.each([false, true])('initializes local application Sessions with cwd or the explicit override (override=%s)', async override => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { openLocalApplication } = await import('../src/application-host');
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-http-workspace-'));
    const directory = path.join(root, 'project'); await mkdir(directory);
    const workingDirectory = path.join(root, 'cwd'); await mkdir(workingDirectory);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workingDirectory);
    let runtime: Awaited<ReturnType<typeof openLocalApplication>> | undefined;
    try {
        runtime = await openLocalApplication({ profile: path.join(root, 'profile'), ...(override ? { setHome: directory } : {}) }, true);
        const id = await runtime.runtime.sessionRepository.createSession('HTTP Session');
        const record = (await runtime.runtime.sessionFiles.inspect(id))!;
        expect(record.cwd).toBe('/workspace');
        expect(record.mounts).toHaveLength(1);
        expect(runtime.runtime.directoryMounts.describe(record.mounts[0])).toBe(override ? directory : workingDirectory);
    } finally { await runtime?.close(); cwd.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

import { expect, it, vi } from 'vitest';
import { createApplicationRuntime, createSessionBrowser, folderBrowserPath } from '@itookit/app-core';
import { FSError, MemoryBackend } from '@itookit/vfs-core';
import { projectTransferTargets } from '../src/projects/transfer-targets';

it('reports the mapped directory and cause for an unavailable local destination', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const browser = await createSessionBrowser({ repository: runtime.sessionRepository, files: runtime.sessionFiles,
        projects: runtime.projects, kernel: runtime.kernel.kernel });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        const source = (await runtime.projects.current())!, target = await runtime.projects.create('Missing target');
        const check = runtime.projects.workspaceReadOnly.bind(runtime.projects);
        vi.spyOn(runtime.projects, 'workspaceReadOnly').mockImplementation(folder => folder === target.path
            ? Promise.reject(new FSError('EACCES', 'Permission denied')) : check(folder));
        const destination = folderBrowserPath(target.path) + '/@files';
        const targets = await projectTransferTargets(runtime.projects, browser.fs, [folderBrowserPath(source.path) + '/@files/a.md']);
        expect(targets.find(node => node.id === destination)?.metadata.custom._disabled).toBe(true);
        expect(info).toHaveBeenCalledWith('[Project transfer]', expect.objectContaining({ stage: 'target-availability',
            projectId: target.project.id, projectName: target.name, directory: target.project.directory,
            path: destination, disabled: true, reason: expect.stringContaining('EACCES'), mounts: [] }));
    } finally { info.mockRestore(); await browser.dispose(); await runtime.dispose(); }
});

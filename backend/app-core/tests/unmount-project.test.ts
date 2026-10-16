import { expect, it, vi } from 'vitest';
import type { ProjectService, SessionLifecycleService } from '@itookit/app-contracts/services';
import { unmountRemoteProject } from '../src/projects/unmount-project';

it('unmounts local records without needing an online remote filesystem or native controller', async () => {
    const project = {path: '/Remote', project: {id: 'p', source: {kind: 'remote'}}};
    const projects = {get: async () => project, removeProjectSource: vi.fn(),
        remoteMounts: {assertUnmountable: vi.fn(), forgetProject: vi.fn(), open: vi.fn(() => {throw new Error('Offline');})}};
    const lifecycle = {deleteFolder: vi.fn(async () => {})};
    await unmountRemoteProject(projects as unknown as ProjectService, lifecycle as unknown as SessionLifecycleService, 'p');
    expect(projects.remoteMounts.open).not.toHaveBeenCalled();
    expect(lifecycle.deleteFolder).toHaveBeenCalledWith('/Remote', true);
    expect(projects.removeProjectSource).toHaveBeenCalledWith(project);
    project.project.source.kind = 'local';
    await expect(unmountRemoteProject(projects as unknown as ProjectService, lifecycle as unknown as SessionLifecycleService, 'p'))
        .rejects.toMatchObject({code: 'EACCES'});
    expect(lifecycle.deleteFolder).toHaveBeenCalledTimes(1);
});

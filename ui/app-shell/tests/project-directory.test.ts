import { expect, it, vi } from 'vitest';
import type { FSNode, IFileSystem } from '@itookit/vfs-core';
import { projectDirectoryNodes } from '../src/projects/project-directory';

it('shares transparent grouping with the tree while keeping normal directories lazy', async () => {
    const node = (path: string, transparent = false) => ({ path, metadata: { navigationTransparent: transparent } }) as FSNode;
    const children: Record<string, FSNode[]> = {
        '/project': [node('/project/group', true), node('/project/files'), node('/project/remote', true)],
        '/project/group': [node('/project/group/session')], '/project/remote': [node('/project/remote/profile')],
    };
    const read = vi.fn(async (path: string) => children[path]);
    const fs = { driver: { getChildren: read } } as unknown as IFileSystem;
    expect((await projectDirectoryNodes(fs, '/project')).map(row => row.path))
        .toEqual(['/project/group/session', '/project/files', '/project/remote/profile']);
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual(['/project', '/project/group', '/project/remote']);
});

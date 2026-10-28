import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {readResource} from '../src/host/resource-references';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
it('resolves notes within the supplied user VFS and refuses namespace traversal', async () => {
    const owners = await Promise.all([1,2].map(async i => {
        const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/home/admin/notes', name: 'same.md', content: `user-${i}`, recursive: true});
        return {vfs: manager, repository: {} as any};
    }));
    const input = {reference: '@notes:/same.md', scope: {navigation: 'projects'}};
    expect((await readResource(owners[0], input)).text).toBe('user-1');
    expect((await readResource(owners[1], input)).text).toBe('user-2');
    await expect(readResource(owners[0], {...input, reference: '@notes:/../private/secret'})).rejects.toThrow('RESOURCE_PATH_INVALID');
    await expect(readResource(owners[0], {...input, reference: '@etc:/llm'})).rejects.toMatchObject({code: 'EINVAL'});
});

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

it('searches file names rather than treating the query as a directory', async () => {
    const {searchResources} = await import('../src/host/resource-references');
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: '/home/admin/notes/essay', name: 'require.md', content: 'private contents', recursive: true});
    const options = {vfs: manager, repository: {} as any};
    expect(await searchResources(options, {query: 'notes:/require', scope: {navigation: 'projects'}}))
        .toEqual([{label: '/essay/require.md', reference: '@notes:/essay/require.md'}]);
    await expect(searchResources(options, {query: 'invalid:/file', scope: {navigation: 'projects'}})).rejects.toMatchObject({code: 'EINVAL'});
});
it('discovers another project by readable name and preserves its scope in references', async () => {
    const {searchResources} = await import('../src/host/resource-references');
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: '/nested', name: 'draft.md', content: 'private contents', recursive: true});
    const project = {name: 'Demo', path: '/Demo', project: {id: 'uuid'}};
    let releases = 0;
    const projects = {list: async () => [project], get: async () => project, openFiles: async () => ({fs, dispose: async () => {releases++;}})};
    const options = {vfs: manager, repository: {} as any, projects: projects as any};
    expect(await searchResources(options, {query: '//De', scope: {navigation: 'projects'}}))
        .toEqual([{label: '/Demo', reference: '@//Demo/'}]);
    expect(await searchResources(options, {query: '//Demo/draft', scope: {navigation: 'projects'}}))
        .toEqual([{label: '/nested/draft.md', reference: '@//Demo/nested/draft.md'}]);
    expect(releases).toBe(1);
});

it('auto reads classify binary references without decoding or staging them', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), options = {vfs: manager, repository: {} as any};
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
    await fs.driver.createFile({parentPath: '/home/admin/notes', name: 'photo.txt', content: bytes.buffer, recursive: true});
    const input = {reference: '@notes:/photo.txt', scope: {navigation: 'notes'}};
    const media = await readResource(options, {...input, mode: 'auto'});
    expect(media).toMatchObject({kind: 'image', mimeType: 'image/jpeg', name: 'photo.txt', bytes: bytes.length});
    expect(new Uint8Array(media.data)).toEqual(bytes);
    expect(media.text).toBeUndefined();
    expect(await fs.driver.exists('/var/lib/inputs.seq')).toBe(false);
    await expect(readResource(options, input)).rejects.toMatchObject({code: 'EINVAL'});
    await fs.driver.createFile({parentPath: '/home/admin/notes', name: 'words.jpg', content: 'actual text'});
    expect(await readResource(options, {...input, reference: '@notes:/words.jpg', mode: 'auto'}))
        .toMatchObject({kind: 'text', mimeType: 'text/plain', text: 'actual text'});
});

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFileSystemSource } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { ProjectSearch } from '@itookit/app-core';
import type { ProjectService } from '@itookit/app-contracts/services';

it('searches unopened on-disk files through the existing local driver without a new driver API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestos-local-search-')), root = join(directory, 'files');
    await mkdir(join(root, 'nested', 'child'), {recursive: true}); await mkdir(join(root, '.private'));
    await writeFile(join(root, 'nested', 'child', 'notes.md'), 'first\nneedle from disk');
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n'); await writeFile(join(root, 'ignored.txt'), 'needle ignored');
    await writeFile(join(root, '.private', 'secret.txt'), 'needle private');
    await writeFile(join(directory, 'outside.txt'), 'needle outside'); await symlink(join(directory, 'outside.txt'), join(root, 'escape.txt'));
    const backend = await openLocalFSBackend({rootDir: root, sidecarDir: join(directory, 'metadata')});
    const owner = await createFileSystemSource({backend, viewId: 'local-search', tags: false});
    const search = new ProjectSearch({forFolder: async () => ({path: '/P', project: {id: 'p'}}),
        openFiles: async () => ({fs: owner.fs, dispose: async () => {}})} as unknown as ProjectService);
    try {
        expect((await search.search('/P', {query: 'notes', scope: 'file-name'})).matches).toMatchObject([{path: 'nested/child/notes.md'}]);
        expect((await search.search('/P', {query: 'needle', scope: 'file-content'})).matches).toMatchObject([{path: 'nested/child/notes.md', line: 2, summary: 'needle from disk'}]);
        expect((await search.search('/P', {query: 'needle', scope: 'file-content', directory: 'nested'})).matches).toHaveLength(1);
        expect((await search.search('/P', {query: 'private', scope: 'file-content', directory: '.private'})).matches).toEqual([]);
    } finally { await owner.dispose(); await rm(directory, {recursive: true, force: true}); }
});

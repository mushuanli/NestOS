import {sha256HexSync} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import {requireValue} from '../kanban/validation';

/** Retain the frozen prompts, protocol, messages and artifacts before removing a clean worktree. */
export async function archiveWorktree(source: IFileSystem, destination: IFileSystem, directory: string, id: string): Promise<string> {
    requireValue(/^[\w-]{1,128}$/.test(id), 'WORKTREE_SCOPE_INVALID');
    const root = '/var/lib/kanban/worktree-archives/' + id, pending = [''], files: Array<{path: string; sha256: string; bytes: number}> = [];
    let total = 0, entries = 0;
    while (pending.length) {
        const suffix = pending.shift()!, children = await source.driver.getChildren(directory + '/_nestos/kanban' + suffix, {fields: 'entry'});
        for (const child of children) {
            requireValue(++entries <= 1000, 'WORKTREE_ARCHIVE_LIMIT');
            requireValue(child.name !== '.' && child.name !== '..' && !child.name.includes('/'), 'WORKTREE_ARCHIVE_PATH_INVALID');
            const path = suffix + '/' + child.name;
            if (child.type === 'directory') {pending.push(path); continue;}
            requireValue(child.type === 'file', 'WORKTREE_ARCHIVE_TYPE_UNSUPPORTED');
            const node = await source.driver.getNode(directory + '/_nestos/kanban' + path);
            requireValue(node?.type === 'file' && Number.isSafeInteger(node.size) && node.size >= 0 && node.size <= 1024 * 1024 && files.length < 1000, 'WORKTREE_ARCHIVE_LIMIT');
            total += node.size; requireValue(total <= 16 * 1024 * 1024, 'WORKTREE_ARCHIVE_LIMIT');
            const file = directory + '/_nestos/kanban' + path;
            const bytes = node.size ? await source.driver.readContent(file, {encoding: 'binary', length: node.size}) : new ArrayBuffer(0);
            const after = await source.driver.getNode(file);
            requireValue(after?.type === 'file' && after.size === node.size && after.revision === node.revision && after.modifiedAt === node.modifiedAt, 'WORKTREE_ARCHIVE_READ_CHANGED');
            requireValue(bytes.byteLength === node.size, 'WORKTREE_ARCHIVE_READ_CHANGED');
            const sha256 = sha256HexSync(bytes); await saveFile(destination, root + path, bytes, sha256);
            files.push({path, sha256, bytes: bytes.byteLength});
        }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = new TextEncoder().encode(JSON.stringify({version: 1, id, files})).buffer;
    await saveFile(destination, root + '/archive-index.json', manifest, sha256HexSync(manifest)); return root;
}
async function saveFile(fs: IFileSystem, path: string, content: ArrayBuffer, digest: string): Promise<void> {
    if (await fs.driver.exists(path)) {
        const node = await fs.driver.getNode(path);
        requireValue(node?.type === 'file' && node.size === content.byteLength, 'WORKTREE_ARCHIVE_CONFLICT');
        const bytes = await fs.driver.readContent(path, {encoding: 'binary', length: node.size});
        requireValue(sha256HexSync(bytes) === digest, 'WORKTREE_ARCHIVE_CONFLICT'); return;
    }
    await fs.driver.createFile({parentPath: path.slice(0, path.lastIndexOf('/')), name: path.slice(path.lastIndexOf('/') + 1), content, recursive: true});
}

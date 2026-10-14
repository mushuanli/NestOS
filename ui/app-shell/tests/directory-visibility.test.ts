import {expect, it, vi} from 'vitest';
import {createFileSystemSource, FileStorageAdapter, type FSNode, type IFileSystem, type FileStorageBackend} from '@itookit/vfs-core';
import {filterGitignoredFiles} from '@itookit/vfs-ui';
import {filterDirectoryFiles} from '../src/projects/directory-visibility';

const node = (path: string, type: 'file' | 'directory' = 'file') => ({path, type} as FSNode);
function source(rules: Record<string, string>, root = '/workspace') {
    const getNode = vi.fn(async (path: string) => path in rules ? {...node(path), size: rules[path].length} : null);
    const readContent = vi.fn(async (path: string) => rules[path]);
    const getNodeType = vi.fn(() => {throw new Error('Redundant type request');});
    const fs = {driver: {getNode, getNodeType, readContent}, discoveryRoot: () => root} as unknown as IFileSystem;
    return {fs, getNode, getNodeType, readContent};
}

it('starts all ancestor rule requests before waiting and reads each rule only once', async () => {
    const s = source({'/workspace/.gitignore': '*.tmp', '/workspace/a/.gitignore': '!keep.tmp'});
    const original = s.getNode.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    s.getNode.mockImplementation(async path => {await gate; return original(path);});
    const entries = [node('/workspace/a/b/hide.tmp'), node('/workspace/a/b/keep.tmp'), node('/workspace/a/b/keep.md')];
    const pending = filterDirectoryFiles(s.fs, entries);
    try {
        expect(s.getNode.mock.calls.map(([path]) => path).sort()).toEqual([
            '/workspace/.gitignore', '/workspace/a/.gitignore', '/workspace/a/b/.gitignore',
        ]);
    } finally {release();}
    expect((await pending).map(item => item.path)).toEqual(['/workspace/a/b/keep.tmp', '/workspace/a/b/keep.md']);
    expect(s.getNodeType).not.toHaveBeenCalled(); expect(s.getNode).toHaveBeenCalledTimes(3);
    expect(s.readContent).toHaveBeenCalledTimes(2);
    expect(s.readContent).toHaveBeenCalledWith('/workspace/.gitignore', expect.objectContaining({representation: 'bytes'}));
});

it('stays within the discovery root and observes externally edited rules on the next read', async () => {
    const rules = {'/workspace/vendor/.gitignore': '*.tmp'};
    const s = source(rules, '/workspace/vendor'), entries = [node('/workspace/vendor/a.tmp'), node('/workspace/vendor/node_modules', 'directory')];
    expect((await filterDirectoryFiles(s.fs, entries)).map(item => item.path)).toEqual(['/workspace/vendor/node_modules']);
    rules['/workspace/vendor/.gitignore'] = '';
    expect(await filterDirectoryFiles(s.fs, entries)).toEqual(entries);
    expect(s.getNode.mock.calls.every(([path]) => path === '/workspace/vendor/.gitignore')).toBe(true);
    expect(s.getNode).toHaveBeenCalledTimes(2);
});

it('propagates a required rule failure after settling speculative reads', async () => {
    const s = source({}), failure = new Error('Remote read failed');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    s.getNode.mockImplementation(async path => {
        if (path === '/workspace/.gitignore') throw failure;
        await gate; return null;
    });
    let settled = false;
    const pending = filterDirectoryFiles(s.fs, [node('/workspace/a/file.md')]).catch(error => {settled = true; throw error;});
    const rejected = expect(pending).rejects.toBe(failure);
    await Promise.resolve(); expect(settled).toBe(false);
    release(); await rejected;
});

it('skips rules below an ignored parent without swallowing errors in a visible directory', async () => {
    const s = source({'/workspace/.gitignore': 'ignored/'}), original = s.getNode.getMockImplementation()!;
    s.getNode.mockImplementation(async path => {
        if (path === '/workspace/ignored/.gitignore') throw new Error('Ignored rule unavailable');
        return original(path);
    });
    expect(await filterDirectoryFiles(s.fs, [node('/workspace/ignored/file.md')])).toEqual([]);
});

it('reduces backend requests through the real VFS while preserving the original filter results', async () => {
    const rules: Record<string, string> = {'.gitignore': '*.tmp', 'a/.gitignore': '!keep.tmp'};
    const stat = vi.fn(async (path: string) => path in rules ? {kind: 'file' as const, size: rules[path].length}
        : path.endsWith('.gitignore') ? null : {kind: 'directory' as const});
    const read = vi.fn(async (path: string) => ({data: new TextEncoder().encode(rules[path])}));
    const backend: FileStorageBackend = {name: 'rules', init: async () => {}, close: async () => {},
        files: {stat, read, list: async () => ({entries: [], nextCursor: null})}};
    const owner = await createFileSystemSource({backend: new FileStorageAdapter(backend), viewId: 'rules', access: 'ro', tags: false});
    stat.mockClear(); read.mockClear();
    const entries = [node('/a/b/hide.tmp'), node('/a/b/keep.tmp'), node('/a/b/keep.md')];
    try {
        const previous = await filterGitignoredFiles(owner.fs, entries);
        const previousRequests = stat.mock.calls.length; expect(read).toHaveBeenCalledTimes(2);
        stat.mockClear(); read.mockClear();
        expect(await filterDirectoryFiles(owner.fs, entries)).toEqual(previous);
        expect(stat.mock.calls.length).toBeLessThan(previousRequests); expect(read).toHaveBeenCalledTimes(2);
    } finally {await owner.dispose();}
});

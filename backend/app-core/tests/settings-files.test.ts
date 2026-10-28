import { expect, it, vi } from 'vitest';
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';
import { SettingsFiles } from '../src/settings/workspace-files';

it('describes sources locally and opens only the selected workspace once', async () => {
    const fs = {} as IFileSystem, open = vi.fn(async () => fs);
    const files = new SettingsFiles({ openFileSystem: open } as unknown as IVFSManager,
        [{ name: 'Notes', workspace: 'notes' }, { name: 'Other', workspace: 'other' }]);
    expect(files.descriptions()).toEqual([{ name: 'Notes', description: undefined }, { name: 'Other', description: undefined }]);
    expect(open).not.toHaveBeenCalled();
    const first = files.open('Notes'); expect(files.open('Notes')).toBe(first); await expect(first).resolves.toBe(fs);
    expect(open).toHaveBeenCalledExactlyOnceWith('/home/admin/notes');
    await expect(files.open('unknown')).rejects.toThrow('not configured');
});
it('retries failed opens and rejects path traversal before reaching the filesystem', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    const files = new SettingsFiles({ openFileSystem: open } as unknown as IVFSManager,
        [{ name: 'Notes', workspace: 'notes' }, { name: 'Invalid', workspace: '../etc' }]);
    await expect(files.open('Notes')).rejects.toThrow('offline'); await files.open('Notes');
    await expect(files.open('Invalid')).rejects.toMatchObject({ code: 'EINVAL' }); expect(open).toHaveBeenCalledTimes(2);
});
it('excludes opted-out and external filesystems from tag enumeration', async () => {
    const fs = { capabilities: { tags: true } } as IFileSystem, open = vi.fn(async () => fs);
    const files = new SettingsFiles({ openFileSystem: open } as unknown as IVFSManager, [
        { name: 'Notes', workspace: 'notes' }, { name: 'Private', workspace: 'private', internal: false },
        { name: 'External', fs: { ...fs, external: true } as IFileSystem },
    ]);
    expect((await files.tags()).map(source => source.name)).toEqual(['Notes']);
    expect(open).toHaveBeenCalledExactlyOnceWith('/home/admin/notes');
});

import { expect, it, vi } from 'vitest';
import { openDirectoryDialog, type DirectoryOpener } from '../../../apps/tauri-app/src/services/directory-dialog';

it('returns the selected host path', async () => {
    const open = vi.fn(async () => '/home/user/project');
    expect(await openDirectoryDialog(open as unknown as DirectoryOpener)).toBe('/home/user/project');
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
});

it('reports a cancel as null without treating it as a failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        expect(await openDirectoryDialog(async () => null)).toBeNull();
        // A multi-selection would be a plugin contract violation, not a chosen directory.
        expect(await openDirectoryDialog(async () => ['/a', '/b'])).toBeNull();
        expect(errors).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
});

it('lets a broken picker reject so it cannot look like a cancel', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const failure = new Error('portal unavailable');
        await expect(openDirectoryDialog(async () => { throw failure; })).rejects.toThrow('portal unavailable');
        expect(errors).toHaveBeenCalledWith('[Mount] Directory dialog failed:', failure);
    } finally { errors.mockRestore(); }
});

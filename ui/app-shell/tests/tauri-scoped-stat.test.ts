import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScopedFsOps } from '../../../apps/tauri-app/src/services/session-directories';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
beforeEach(() => { invoke.mockReset(); vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } }); });
afterEach(() => vi.unstubAllGlobals());

it('passes bounded read offsets through the same grant without reading the whole file', async () => {
    const fs = new ScopedFsOps([{ id: 'project', root: '/project' }]);
    invoke.mockResolvedValueOnce([109, 100, 120]);
    expect(new TextDecoder().decode((await fs.readFileRange('/project/file', 12, 3))!)).toBe('mdx');
    expect(invoke).toHaveBeenCalledWith('directory_read_range', { id: 'project', path: 'file', offset: 12, length: 3 }, undefined);
    invoke.mockRejectedValueOnce(new Error('closed'));
    await expect(fs.readFileRange('/project/file', 0, 3)).rejects.toThrow('closed');
});

it('batches directory stats by grant, preserves order and chunks large listings', async () => {
    invoke.mockImplementation(async (_name, args) => args.paths.map((path: string) => path === 'missing' ? null : { size: path.length }));
    const fs = new ScopedFsOps([{ id: 'meta', root: '/data/meta' }, { id: 'project', root: '/project' }]);
    expect(await fs.statMany(['/project/abc', '/data/meta/x', '/project/missing']))
        .toEqual([{ size: 3 }, { size: 1 }, null]);
    expect(invoke).toHaveBeenCalledWith('directory_stat_many', { id: 'project', paths: ['abc', 'missing'] }, undefined);
    expect(invoke).toHaveBeenCalledWith('directory_stat_many', { id: 'meta', paths: ['x'] }, undefined);
    invoke.mockClear();
    await fs.statMany(Array.from({ length: 600 }, (_, i) => `/project/f${i}`));
    expect(invoke.mock.calls.map(([, args]) => args.paths.length)).toEqual([256, 256, 88]);
    invoke.mockClear();
    await expect(fs.statMany(['/outside'])).rejects.toThrow('outside');
    expect(invoke).not.toHaveBeenCalled();
});

it('does not hide grant revocation or malformed batch results', async () => {
    const fs = new ScopedFsOps([{ id: 'project', root: '/project' }]);
    invoke.mockRejectedValueOnce(new Error('directory grant has been closed'));
    await expect(fs.statMany(['/project/file'])).rejects.toThrow('closed');
    invoke.mockResolvedValueOnce([]);
    await expect(fs.statMany(['/project/file'])).rejects.toThrow('Invalid directory stat response');
});

it('receives binary file responses without JSON conversion and preserves missing files', async () => {
    const fs = new ScopedFsOps([{ id: 'project', root: '/project' }]);
    const bytes = new Uint8Array([0, 128, 255, 10]).buffer;
    invoke.mockResolvedValueOnce(bytes);
    expect(await fs.readFile('/project/file')).toBe(bytes);
    expect(invoke).toHaveBeenCalledWith('directory_read_file', { id: 'project', path: 'file' }, undefined);
    invoke.mockResolvedValueOnce(null);
    expect(await fs.readFile('/project/missing')).toBeNull();
    invoke.mockRejectedValueOnce(new Error('closed'));
    await expect(fs.readFile('/project/file')).rejects.toThrow('closed');
});

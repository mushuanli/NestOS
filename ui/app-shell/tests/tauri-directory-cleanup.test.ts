import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TauriSessionDirectories } from '../../../apps/tauri-app/src/services/session-directories';

const mocks = vi.hoisted(() => ({ dispose: vi.fn(), invoke: vi.fn() }));
vi.mock('@itookit/vfs-core', async importOriginal => ({ ...await importOriginal<object>(),
    createFileSystemSource: async () => ({ fs: {}, dispose: mocks.dispose }),
}));
vi.mock('@itookit/vfsdriver-local', async importOriginal => ({ ...await importOriginal<object>(),
    openLocalFSBackend: async () => ({ close: async () => {} }),
}));
beforeEach(() => {
    mocks.dispose.mockReset().mockResolvedValue(undefined);
    mocks.invoke.mockReset().mockImplementation(async (command, params) => {
        if (command === 'directory_open') return { id: params.path, root: params.path };
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
});
afterEach(() => vi.unstubAllGlobals());

it('retains failed cleanup steps and never closes grants before their source is disposed', async () => {
    const directories = new TauriSessionDirectories('/data');
    await directories.openDirectory('/a'); await directories.openDirectory('/b');
    mocks.dispose.mockRejectedValueOnce(new Error('owner failed'));
    mocks.invoke.mockImplementation(async (command, params) => {
        if (command === 'directory_close' && params.id === '/a') throw new Error('grant failed');
    });
    const first = await directories.dispose().catch(error => error);
    expect(first.errors.map((error: Error) => error.message)).toEqual(['owner failed']);
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'directory_close')).toHaveLength(2);
    await expect(directories.openDirectory('/c')).rejects.toThrow('closed');
    const second = await directories.dispose().catch(error => error);
    expect(second.errors.map((error: Error) => error.message)).toEqual(['grant failed']);
    expect(mocks.dispose).toHaveBeenCalledTimes(3);
    mocks.invoke.mockResolvedValue(undefined);
    await Promise.all([directories.dispose(), directories.dispose()]);
    expect(mocks.dispose).toHaveBeenCalledTimes(3);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'directory_close')).toHaveLength(5);
});

it('waits for pending directory acquisition and merges concurrent disposal', async () => {
    const directories = new TauriSessionDirectories('/data');
    let resolve!: (value: { id: string; root: string }) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const opening = directories.openDirectory('/pending');
    const first = directories.dispose(), second = directories.dispose();
    expect(first).toBe(second);
    expect(mocks.dispose).not.toHaveBeenCalled();
    resolve({ id: 'pending', root: '/pending' });
    await opening; await first;
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('directory_close', { id: 'pending' }, undefined);
});

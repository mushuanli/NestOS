import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.fn();
beforeEach(() => vi.stubGlobal('window', { __TAURI_INTERNALS__: {
    invoke: (command: string, args: unknown) => invoke(command, args),
} }));
afterEach(() => vi.unstubAllGlobals());
import { TauriNativeShell } from '../../../apps/tauri-app/src/shell/tauri-native-shell';
import { createTauriSessionProcesses } from '../../../apps/tauri-app/src/shell/session-bash';

it.each(['sh', 'bash'])('passes %s tool commands to Bash and preserves stderr and nonzero status', async command => {
    invoke.mockReset().mockResolvedValueOnce({ ripgrep: false, fd: false }).mockResolvedValueOnce(['output', 'diagnostic', 7]);
    const shell = await TauriNativeShell.create();
    const result = await shell.exec(command, ['-c', 'printf output; exit 7'], { cwd: '/workspace', timeoutMs: 500 });
    expect(result).toEqual({ stdout: 'output', stderr: 'diagnostic', code: 7 });
    expect(invoke).toHaveBeenLastCalledWith('shell_exec', expect.objectContaining({
        command: 'printf output; exit 7', cwd: '/workspace', timeoutMs: 500, requestId: expect.any(String),
    }));
});

it('does not start a cancelled command', async () => {
    invoke.mockReset().mockResolvedValueOnce({ ripgrep: false, fd: false });
    const shell = await TauriNativeShell.create();
    expect((await shell.exec('bash', ['-c', 'echo no'], { signal: AbortSignal.abort() })).code).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
});

it('cancels the same request and removes the abort listener after completion', async () => {
    let finish!: (result: [string, string, number]) => void;
    invoke.mockReset().mockResolvedValueOnce({ ripgrep: false, fd: false })
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const shell = await TauriNativeShell.create(), controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const operation = shell.exec('bash', ['-c', 'sleep 10'], { signal: controller.signal });
    const requestId = invoke.mock.calls[1][1].requestId;
    controller.abort();
    expect(invoke).toHaveBeenLastCalledWith('shell_cancel', { requestId });
    finish(['', '', -1]); await operation;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('maps granted mounts and stops active Session commands before closing directory handles', async () => {
    let finish!: (value: [string, string, number]) => void;
    invoke.mockReset().mockImplementation(async (command, args) => {
        if (command === 'directory_open') return { id: args.path };
        if (command === 'session_shell_exec') return new Promise(resolve => { finish = resolve; });
        if (command === 'shell_cancel') finish(['', 'cancelled', -1]);
    });
    const files = { cwd: '/workspace', release: async () => {},
        vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: vi.fn(async () => []) } };
    const scope = await createTauriSessionProcesses('/mindos')('one', files, [
        { sourceId: 'admin-home', directory: '/home/admin/project', at: '/workspace', access: 'rw' },
        { sourceId: 'external', directory: '/selected/input', at: '/input', access: 'ro' },
    ]);
    const operation = scope.nativeShell.exec('sh', ['-c', 'mindos run --headless']);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('session_shell_exec', expect.objectContaining({
        mounts: [['/mindos/home/admin/project', '/workspace', true], ['/selected/input', '/input', false]], cwd: '/workspace',
    })));
    await scope.release();
    expect((await operation).code).toBe(-1);
    const commands = invoke.mock.calls.map(call => call[0]);
    expect(commands.indexOf('shell_cancel')).toBeLessThan(commands.indexOf('directory_close'));
    await expect(scope.nativeShell.exec('bash', ['-c', 'true'])).rejects.toThrow('scope closed');
});

it('refuses a revoked Session view before issuing process IPC', async () => {
    invoke.mockReset().mockResolvedValue({ id: 'grant' });
    const scope = await createTauriSessionProcesses('/mindos')('one', { cwd: '/workspace', release: async () => {},
        vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => { throw new Error('view revoked'); } },
    }, [{ sourceId: 'external', directory: '/selected', at: '/workspace', access: 'rw' }]);
    await expect(scope.nativeShell.exec('bash', ['-c', 'true'])).rejects.toThrow('view revoked');
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['directory_open']);
    await scope.release();
});


it('waits for commands and closes every grant after cancellation IPC fails', async () => {
    let finish!: (value: [string, string, number]) => void;
    const cancelled = new Error('cancel IPC failed'), closeFailed = new Error('close IPC failed');
    invoke.mockReset().mockImplementation(async (command, args) => {
        if (command === 'directory_open') return { id: args.path };
        if (command === 'session_shell_exec') return new Promise(resolve => { finish = resolve; });
        if (command === 'shell_cancel') throw cancelled;
        if (command === 'directory_close' && args.id === '/one') throw closeFailed;
    });
    const scope = await createTauriSessionProcesses('/mindos')('one', { cwd: '/workspace', release: async () => {},
        vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] },
    }, [{ sourceId: 'one', directory: '/one', at: '/workspace', access: 'rw' },
        { sourceId: 'two', directory: '/two', at: '/input', access: 'ro' }]);
    const operation = scope.nativeShell.exec('bash', ['-c', 'sleep 1']);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const release = scope.release();
    const outcome = release.catch(error => error);
    expect(scope.release()).toBe(release);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('shell_cancel', expect.anything()));
    expect(invoke.mock.calls.some(([command]) => command === 'directory_close')).toBe(false);
    finish(['', '', 0]); await operation;
    expect((await outcome).errors).toEqual([cancelled, closeFailed]);
    expect(invoke.mock.calls.filter(([command]) => command === 'directory_close').map(([, args]) => args.id)).toEqual(['/one', '/two']);
    invoke.mockResolvedValue(undefined);
    await Promise.all([scope.release(), scope.release()]);
    expect(invoke.mock.calls.filter(([command]) => command === 'directory_close').map(([, args]) => args.id))
        .toEqual(['/one', '/two', '/one']);
    expect(invoke.mock.calls.filter(([command]) => command === 'shell_cancel')).toHaveLength(1);
});


it('reports initialization and grant cleanup failures together', async () => {
    const opening = new Error('open failed'), closing = new Error('close failed');
    invoke.mockReset().mockImplementation(async (command, args) => {
        if (command === 'directory_open' && args.path === '/one') return { id: 'one' };
        if (command === 'directory_open') throw opening;
        if (command === 'directory_close') throw closing;
    });
    const outcome = await createTauriSessionProcesses('/mindos')('one', { cwd: '/workspace', release: async () => {},
        vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] },
    }, [{ sourceId: 'one', directory: '/one', at: '/workspace', access: 'rw' },
        { sourceId: 'two', directory: '/two', at: '/input', access: 'ro' }]).catch(error => error);
    expect(outcome.errors[0]).toBe(opening);
    expect(outcome.errors[1].errors).toEqual([closing]);
    expect(invoke).toHaveBeenLastCalledWith('directory_close', { id: 'one' });
});

it('binds an isolated workspace file view and Tauri Bash to the same copy', async () => {
    const { createVFS, MemoryBackend } = await import('@itookit/vfs-core');
    const { SessionFilesService, acquireWorkspaceProcessContext } = await import('@itookit/app-core');
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    await root.driver.createFile({ parentPath: '/base', name: 'file', content: 'base', recursive: true });
    await root.driver.createFile({ parentPath: '/copy', name: 'file', content: 'copy', recursive: true });
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/base'));
    await files.configure('s', { mounts: [{ mountId: 'work', sourceId: 'admin-home', at: '/workspace', access: 'rw' }], cwd: '/workspace' }, 0);
    invoke.mockReset().mockImplementation(async (command, args) => {
        if (command === 'directory_open') return { id: args.path };
        if (command === 'session_shell_exec') return ['native-copy-output', '', 0];
    });
    let context: Awaited<ReturnType<typeof acquireWorkspaceProcessContext>> | undefined;
    try {
        context = await acquireWorkspaceProcessContext(files, 's', {
            mountId: 'work', fs: await manager.openFileSystem('/copy'), directory: '/native/worktree',
        }, createTauriSessionProcesses('/mindos'), async () => [
            { sourceId: 'admin-home', directory: '/home/admin/base', at: '/workspace', access: 'rw' },
        ]);
        expect(await context.vfs.readFile('file')).toBe('copy');
        await context.vfs.writeFile('file', 'isolated edit');
        expect(await root.driver.readContent('/base/file', { encoding: 'utf-8' })).toBe('base');
        expect((await context.nativeShell!.exec('bash', ['-c', 'cat file'])).stdout).toBe('native-copy-output');
        expect(invoke).toHaveBeenCalledWith('directory_open', { path: '/native/worktree' });
        expect(invoke).toHaveBeenCalledWith('session_shell_exec', expect.objectContaining({
            cwd: '/workspace', mounts: [['/native/worktree', '/workspace', true]],
        }));
        await files.disable('s', 1);
        const started = invoke.mock.calls.filter(([name]) => name === 'session_shell_exec').length;
        await expect(context.nativeShell!.exec('bash', ['-c', 'cat file'])).rejects.toMatchObject({ code: 'EACCES' });
        expect(invoke.mock.calls.filter(([name]) => name === 'session_shell_exec')).toHaveLength(started);
        await context.release();
        expect(invoke).toHaveBeenCalledWith('directory_close', { id: '/native/worktree' });
    } finally { await context?.release(); await files.dispose(); await manager.dispose(); }
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionFilesService, type ApplicationPlatformServices, type HeadlessKernelRuntime } from '@itookit/app-core';
import { TauriFlowWorkspaces } from '../../../apps/tauri-app/src/shell/flow-workspaces';
import { TauriSessionDirectories } from '../../../apps/tauri-app/src/services/session-directories';

const invoke = vi.fn(), copies = new Set<string>();
const intents = new Map<string, number[]>();
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
    copies.clear();
    intents.clear();
    invoke.mockReset().mockImplementation(async (command, params) => {
        if (command === 'fs_write_file') intents.set(params.path, params.data);
        if (command === 'fs_read_file') return new Uint8Array(intents.get(params.path) ?? []).buffer;
        if (command === 'fs_read_dir') return [...intents.keys()].map(path => ({ name: path.split('/').at(-1), is_directory: false }));
        if (command === 'fs_remove') intents.delete(params.path);
        if (command === 'directory_open') return { id: `grant:${params.path}`, root: params.path };
        if (command !== 'git_command') return;
        const args = params.args;
        if (args[0] === 'worktree' && args[1] === 'add') copies.add(args[4]);
        if (args[0] === 'worktree' && args[1] === 'remove') copies.delete(args.at(-1));
        return [args[1] === 'list' ? [...copies].map(path => `worktree ${path}\n`).join('') : '', '', 0];
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: (command: string, params: unknown) => invoke(command, params) } });
});
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    for (const directory of ['base', 'copy']) await root.driver.createFile({ parentPath: `/${directory}`, name: 'file', content: directory, recursive: true });
    const files = new SessionFilesService(root); await files.initialize(); cleanup.push(() => files.dispose());
    files.registerSource('admin-home', await manager.openFileSystem('/base'));
    await files.configure('s', { mounts: [{ mountId: 'work', at: '/workspace', sourceId: 'admin-home', access: 'rw' }], cwd: '/workspace' }, 0);
    const services = { sessionFiles: files, directoryMounts: { processMounts: async () => [
        { sourceId: 'admin-home', directory: '/home/admin/base', at: '/workspace', access: 'rw' },
    ] } } as ApplicationPlatformServices;
    const getShared = vi.fn();
    const listTasks = vi.fn(async (): Promise<Array<{ id: string; program: { kind: string }; labels: { kind: string } }>> => []);
    const inspectSession = vi.fn(async () => ({ getShared, listTasks }));
    const kernel = { kernel: { inspectSession } } as unknown as HeadlessKernelRuntime;
    const workspaces = new TauriFlowWorkspaces('/data'); workspaces.bind(kernel, services);
    return { workspaces, files, manager, services, kernel, getShared, listTasks, inspectSession };
}

it('skips the Session Task scan while no retained intent exists', async () => {
    const { workspaces, inspectSession, listTasks } = await setup();
    await workspaces.reconcile('s');
    expect(inspectSession).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
});

it('still reconciles a retained intent for its owning Session', async () => {
    const { workspaces, kernel, services, inspectSession } = await setup();
    await workspaces.prepare('s', { mode: 'worktree' });
    expect(intents.size).toBe(1);
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    await next.reconcile('s');
    expect(inspectSession).toHaveBeenCalledWith('s');
    expect(copies.size).toBe(0);
    expect(intents.size).toBe(0);
});

it('creates distinct copies for concurrent runs and restores the persisted lease after host reconstruction', async () => {
    const { workspaces, kernel, services } = await setup();
    const policy = { mode: 'worktree' as const, merge: 'discard' as const };
    const leases = await Promise.all([workspaces.prepare('s', policy), workspaces.prepare('s', policy)]);
    expect(copies.size).toBe(2);
    expect(leases.map(lease => lease.directory)).toEqual(['/workspace', '/workspace']);
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    await (await next.restore('s', policy, leases[0].record!)).finish('succeeded');
    expect(copies.size).toBe(1);
    await leases[1].finish('succeeded');
    expect(copies.size).toBe(0);
});

it('reclaims an unclaimed intent before preparing a new copy in a reconstructed host', async () => {
    const { workspaces, kernel, services } = await setup();
    await workspaces.prepare('s', { mode: 'worktree' });
    const oldDirectory = [...copies][0], oldIntent = [...intents.keys()][0];
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    await next.prepare('s', { mode: 'worktree' });
    expect(copies.has(oldDirectory)).toBe(false);
    expect(intents.has(oldIntent)).toBe(false);
    expect(copies.size).toBe(1);
    expect(intents.size).toBe(1);
});

it('preserves a copy claimed by a persisted Run while preparing another run', async () => {
    const { workspaces, kernel, services, getShared, listTasks } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree' });
    const oldDirectory = [...copies][0];
    listTasks.mockResolvedValue([{ id: 'published', program: { kind: 'flow.aggregate' }, labels: { kind: 'flow-root' } }]);
    getShared.mockImplementation(async (key: string) => ({ value: key.endsWith('.scheduler')
        ? { spec: { runPolicy: { workspace: { mode: 'worktree' } } } } : lease.record }));
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    await next.prepare('s', { mode: 'worktree' });
    expect(copies.has(oldDirectory)).toBe(true);
    expect(copies.size).toBe(2);
    expect(getShared).toHaveBeenCalledWith('flow.run.published.workspace-lease');
});

it('retains a worktree claimed in the root before its first shared checkpoint', async () => {
    const { workspaces, kernel, services, listTasks } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree' });
    const oldDirectory = [...copies][0];
    listTasks.mockResolvedValue([{ id: 'root', program: { kind: 'flow.aggregate' }, labels: { kind: 'flow-root' },
        input: { initialWorkspace: lease.record } } as any]);
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    await next.prepare('s', { mode: 'worktree' });
    expect(copies.has(oldDirectory)).toBe(true);
    expect(copies.size).toBe(2);
});

it('rejects changed grants and foreign lease identities without issuing Git commands', async () => {
    const { workspaces, files } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree' });
    invoke.mockClear();
    await expect(workspaces.restore('another', { mode: 'worktree' }, lease.record!)).rejects.toThrow('another Session');
    const record = await files.inspect('s');
    await files.configure('s', { mounts: record!.mounts, cwd: '/workspace' }, record!.revision);
    await expect(workspaces.restore('s', { mode: 'worktree' }, lease.record!)).rejects.toThrow('authorization no longer matches');
    expect(invoke).not.toHaveBeenCalled();
});

it('permits a missing copy only for finalization recovery', async () => {
    const { workspaces } = await setup();
    const policy = { mode: 'worktree' as const, merge: 'discard' as const };
    const lease = await workspaces.prepare('s', policy);
    copies.clear();
    await expect(workspaces.restore('s', policy, lease.record!)).rejects.toThrow('Worktree is missing');
    await (await workspaces.restore('s', policy, lease.record!, { forFinalization: true })).finish('succeeded');
});

it('records recovery identity before Git and retains it when post-command cleanup fails', async () => {
    const { workspaces } = await setup();
    const original = invoke.getMockImplementation()!;
    let intent: { path: string; data: number[] } | undefined;
    invoke.mockImplementation(async (command, params) => {
        if (command === 'fs_write_file') intent = params;
        if (command === 'git_command' && params.args[1] === 'add') {
            expect(intent).toBeDefined();
            const record = JSON.parse(new TextDecoder().decode(new Uint8Array(intent!.data)));
            expect(record.directory).toBe(params.args[4]);
            expect(record.git.branch).toBe(params.args[3]);
            expect(record.grant.sessionId).toBe('s');
        }
        if (command === 'directory_close') throw new Error('close failed after creation');
        return original(command, params);
    });
    await expect(workspaces.prepare('s', { mode: 'worktree' })).rejects.toThrow('cleanup failed');
    expect(copies.size).toBe(1);
    expect(intent!.path).toContain('/.intents/');
    expect(invoke.mock.calls.some(([command]) => command === 'fs_remove')).toBe(false);
});

it('does not create a worktree when writing its recovery intent fails', async () => {
    const { workspaces } = await setup();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, params) => {
        if (command === 'fs_write_file') throw new Error('intent storage unavailable');
        return original(command, params);
    });
    await expect(workspaces.prepare('s', { mode: 'worktree' })).rejects.toThrow('intent storage unavailable');
    expect(copies.size).toBe(0);
    expect(invoke.mock.calls.some(([command]) => command === 'git_command')).toBe(false);
});

it('removes an unpublished copy when authorization changes during creation, even with keep policy', async () => {
    const { workspaces, files } = await setup();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, params) => {
        const result = await original(command, params);
        if (command === 'git_command' && params.args[1] === 'add') {
            const record = (await files.inspect('s'))!;
            await files.configure('s', { mounts: record.mounts, cwd: record.cwd }, record.revision);
        }
        return result;
    });
    await expect(workspaces.prepare('s', { mode: 'worktree', cleanup: 'keep' })).rejects.toThrow('authorization no longer matches');
    expect(copies.size).toBe(0);
    expect(invoke.mock.calls.some(([command, params]) => command === 'git_command'
        && params.args[0] === 'branch' && params.args[1] === '-D')).toBe(true);
});

it('releases acquired process grants and the copy source when authorization changes during source opening', async () => {
    const { workspaces, manager, files, getShared } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree' });
    getShared.mockImplementation(async (key: string) => ({ value: key.endsWith('.scheduler')
        ? { spec: { runPolicy: { workspace: { mode: 'worktree' } } } } : lease.record }));
    vi.spyOn(TauriSessionDirectories.prototype, 'openDirectory').mockImplementation(async () => {
        const record = (await files.inspect('s'))!;
        await files.configure('s', { mounts: record.mounts, cwd: record.cwd }, record.revision);
        return manager.openFileSystem('/copy');
    });
    const disposed = vi.spyOn(TauriSessionDirectories.prototype, 'dispose').mockResolvedValue(undefined);
    invoke.mockClear();
    await expect(workspaces.fileContext('s', 'root')).rejects.toThrow('authorization no longer matches');
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('directory_close', { id: `grant:${[...copies][0]}` });
    expect(copies.size).toBe(1);
});

it('uses the copy for both file tools and native mounts and releases it after process grants', async () => {
    const { workspaces, manager, files, getShared } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree' });
    getShared.mockImplementation(async (key: string) => ({ value: key.endsWith('.scheduler')
        ? { spec: { runPolicy: { workspace: { mode: 'worktree' } } } } : lease.record }));
    const opened = vi.spyOn(TauriSessionDirectories.prototype, 'openDirectory').mockResolvedValue(await manager.openFileSystem('/copy'));
    const disposed = vi.spyOn(TauriSessionDirectories.prototype, 'dispose').mockImplementation(async () => {
        expect(invoke).toHaveBeenCalledWith('directory_close', { id: `grant:${[...copies][0]}` });
    });
    invoke.mockClear();
    const context = await workspaces.fileContext('s', 'root');
    expect(getShared).toHaveBeenCalledWith('flow.run.root.workspace-lease');
    expect(opened).toHaveBeenCalledWith([...copies][0]);
    expect(await context.vfs.readFile('file')).toBe('copy');
    expect(invoke).toHaveBeenCalledWith('directory_open', { path: [...copies][0] });
    const ordinary = await files.acquire('s');
    expect(await ordinary.vfs.readFile('file')).toBe('base'); await ordinary.release();
    await Promise.all([context.release(), context.release()]);
    expect(disposed).toHaveBeenCalledTimes(1);
});

it('retains directory sources until a failed process-grant close succeeds on retry', async () => {
    const { workspaces, manager, getShared } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree' });
    getShared.mockImplementation(async (key: string) => ({ value: key.endsWith('.scheduler')
        ? { spec: { runPolicy: { workspace: { mode: 'worktree' } } } } : lease.record }));
    vi.spyOn(TauriSessionDirectories.prototype, 'openDirectory').mockResolvedValue(await manager.openFileSystem('/copy'));
    const disposed = vi.spyOn(TauriSessionDirectories.prototype, 'dispose').mockResolvedValue(undefined);
    const context = await workspaces.fileContext('s', 'root');
    const original = invoke.getMockImplementation()!;
    let failed = false;
    invoke.mockImplementation(async (command, params) => {
        if (command === 'directory_close' && params.id === `grant:${[...copies][0]}` && !failed) {
            failed = true; throw new Error('grant close failed');
        }
        return original(command, params);
    });
    try {
        await expect(context.release()).rejects.toThrow('Session process cleanup failed');
        expect(disposed).not.toHaveBeenCalled();
        await Promise.all([context.release(), context.release()]);
        expect(disposed).toHaveBeenCalledOnce();
    } finally { await context.release(); }
});

it('restores a read-only snapshot with read-only file and Bash grants', async () => {
    const { workspaces, manager, kernel, services, getShared } = await setup();
    const policy = { mode: 'read-only' as const };
    const lease = await workspaces.prepare('s', policy);
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    const restored = await next.restore('s', policy, lease.record!);
    await expect(next.restore('s', { mode: 'worktree' }, lease.record!)).rejects.toThrow('frozen policy');
    getShared.mockImplementation(async (key: string) => ({ value: key.endsWith('.scheduler')
        ? { spec: { runPolicy: { workspace: policy } } } : lease.record }));
    vi.spyOn(TauriSessionDirectories.prototype, 'openDirectory').mockResolvedValue(await manager.openFileSystem('/copy'));
    vi.spyOn(TauriSessionDirectories.prototype, 'dispose').mockResolvedValue(undefined);
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, params) => command === 'session_shell_exec' ? ['copy', '', 0] : original(command, params));
    const context = await next.fileContext('s', 'root');
    try {
        expect(await context.vfs.readFile('file')).toBe('copy');
        await expect(context.vfs.writeFile('file', 'denied')).rejects.toMatchObject({ code: 'EROFS' });
        await context.nativeShell!.exec('bash', ['-c', 'cat file']);
        expect(invoke).toHaveBeenCalledWith('session_shell_exec', expect.objectContaining({ mounts: [[`grant:${[...copies][0]}`, '/workspace', false]] }));
    } finally { await context.release(); }
    await restored.finish('succeeded');
    expect(copies.size).toBe(0);
});

it('rejects merge policies for read-only workspaces before creating any host resources', async () => {
    const { workspaces } = await setup();
    await expect(workspaces.prepare('s', { mode: 'read-only', merge: 'auto-if-clean' })).rejects.toThrow('cannot merge');
    expect(invoke).not.toHaveBeenCalled();
});

it('retains orphan intents with actionable diagnostics after grants change', async () => {
    const { workspaces, kernel, services, files } = await setup();
    await workspaces.prepare('s', { mode: 'worktree' });
    const directory = [...copies][0], paths = [...intents.keys()];
    const record = (await files.inspect('s'))!;
    await files.configure('s', { mounts: record.mounts, cwd: record.cwd }, record.revision);
    const next = new TauriFlowWorkspaces('/data'); next.bind(kernel, services);
    invoke.mockClear();
    await expect(next.reconcile('s')).rejects.toThrow(`Retained workspace ${directory}`);
    expect([...intents.keys()]).toEqual(paths);
    expect(copies.has(directory)).toBe(true);
    expect(invoke.mock.calls.some(([command]) => command === 'git_command' || command === 'fs_remove')).toBe(false);
});

it('retains recovery intents when the Kernel cannot inspect the Session', async () => {
    const { workspaces, services } = await setup();
    await workspaces.prepare('s', { mode: 'worktree' });
    const paths = [...intents.keys()];
    const next = new TauriFlowWorkspaces('/data');
    next.bind({ kernel: { inspectSession: async () => { throw new Error('Session not discovered'); } } } as unknown as HeadlessKernelRuntime, services);
    await expect(next.reconcile('s')).rejects.toThrow('workspace intents are retained in /data/var/lib/worktrees/.intents');
    expect([...intents.keys()]).toEqual(paths);
    expect(copies.size).toBe(1);
});


it('returns retained native paths for the durable Run finalization report', async () => {
    const { workspaces } = await setup();
    const lease = await workspaces.prepare('s', { mode: 'worktree', cleanup: 'keep', merge: 'manual' });
    const report = await lease.finish('cancelled');
    expect(report?.message).toContain(`Retained workspace: ${[...copies][0]}`);
    expect(report?.message).toContain('Retained branch: flow/');
    expect(intents.size).toBe(0);
    expect(copies.size).toBe(1);
});

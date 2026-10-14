import { mkdir, readFile, writeFile, rename, readdir, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createVFS, type IDeviceDriver } from '@itookit/vfs-core';
import { SessionFilesService, createKernelRuntime, type ApplicationPlatformServices } from '@itookit/app-core';
import { withWorkspaceScopeCleanup } from '../../../../backend/app-core/src/runtime/workspace-scope-cleanup';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '../../../../apps/cli/src/sqlite-sidecar';
import { DurableFlowExecutor, type FlowExecutionHandle } from '../../../../backend/llm-flow/src/index';
import { TauriFlowWorkspaces } from '../../../../apps/tauri-app/src/shell/flow-workspaces';

const [rootDir, phase] = process.argv.slice(2);
const grants = new Map<string, string>();
let sequence = 0;
async function pauseAt(point: string): Promise<void> {
    if (phase !== point) return;
    process.send?.({ point });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
}

/** Node transport replacement: real disk and Git, not the native Tauri IPC boundary. */
async function invoke(command: string, params: any): Promise<unknown> {
    switch (command) {
        case 'fs_mkdir': return mkdir(params.path, { recursive: true });
        case 'fs_write_file':
            await writeFile(`${params.path}.tmp`, Buffer.from(params.data));
            await rename(`${params.path}.tmp`, params.path);
            await pauseAt('intent'); return;
        case 'fs_read_file': return new Uint8Array(await readFile(params.path)).buffer;
        case 'fs_read_dir': return (await readdir(params.path, { withFileTypes: true })).map(item => ({ name: item.name, is_directory: item.isDirectory() }));
        case 'fs_remove': return rm(params.path, { force: true });
        case 'directory_open': {
            const path = await realpath(params.path), id = String(++sequence); grants.set(id, path); return { id, root: path };
        }
        case 'directory_close': grants.delete(params.id); return;
        case 'git_command': {
            const cwd = grants.get(params.repositoryId);
            if (!cwd) throw new Error('Missing directory grant');
            const result = spawnSync('git', params.args, { cwd, encoding: 'utf8', timeout: 10_000 });
            if (result.error) throw result.error;
            if (params.args[1] === 'add' && result.status === 0) await pauseAt('created');
            return [result.stdout, result.stderr, result.status];
        }
        default: throw new Error(`Unexpected transport command: ${command}`);
    }
}

Object.assign(globalThis, { window: { __TAURI_INTERNALS__: { invoke } } });
async function finishGate(run: FlowExecutionHandle): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const gate = run.nodes.get('gate');
        if (gate && (await gate.status()).task.interactions.go) {
            await gate.respond({ interactionId: 'go', value: 'done' }); return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Recovered human node did not request input');
}
const backend = await openLocalFSBackend({ rootDir: `${rootDir}/state`, sidecarDir: `${rootDir}/meta`, createDb: NodeSqliteSidecarDb.open });
const { manager } = await createVFS({ rootBackend: backend });
const root = await manager.openFileSystem('/');
const files = new SessionFilesService(root); await files.initialize();
files.registerSource('admin-home', root);
if (!await files.inspect('s')) await files.configure('s', { mounts: [{ mountId: 'work', sourceId: 'admin-home', at: '/workspace', access: 'rw' }], cwd: '/workspace' }, 0);
const services = { sessionFiles: files, directoryMounts: { processMounts: async () => [
    { sourceId: 'admin-home', directory: '/repository', at: '/workspace', access: 'rw' },
] } } as ApplicationPlatformServices;
const kernel = await createKernelRuntime({ systemFS: root, llmDriver: {} as IDeviceDriver, recover: false,
    storageResolver: { kind: 'test', resolve: async () => ({ fs: root, rootPath: '/sessions/s' }) } });
if (!phase.startsWith('recover')) await kernel.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
const workspaces = new TauriFlowWorkspaces(rootDir); workspaces.bind(kernel, services);
const executor = new DurableFlowExecutor({ kernel: kernel.kernel, plugins: kernel.dagPlugins,
    workspaceManager: withWorkspaceScopeCleanup(workspaces, kernel), schedulerLeaseTtlMs: 100 });
try {
    if (phase === 'published') {
        await executor.submit('s', { runPolicy: { workspace: { mode: 'worktree', cleanup: 'always', merge: 'discard' } },
            nodes: [{ id: 'gate', name: 'Gate', plugin: 'builtin.human', pluginVersion: '1.0.0',
                config: { requestId: 'go', prompt: 'Continue' }, inputs: {}, capabilities: [] }], edges: [] });
        await pauseAt('published');
    } else if (phase === 'recover-published') {
        await workspaces.reconcile('s');
        const inspection = await kernel.kernel.inspectSession('s');
        const task = (await inspection.listTasks()).find(task => task.labels?.kind === 'flow-root')!;
        const lease = (await inspection.getShared(`flow.run.${task.id}.workspace-lease`))!.value as any;
        await realpath(lease.directory);
        await writeFile(`${rootDir}/retained.json`, JSON.stringify({ directory: lease.directory }));
        const owner = (await inspection.getShared(`flow.run.${task.id}.scheduler-owner`))!.value as any;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, owner.expiresAt - Date.now() + 5)));
        await kernel.kernel.recoverSession('s', { takeover: true });
        const session = await kernel.kernel.openSession('s');
        const run = await executor.resume('s', task.id);
        await finishGate(run);
        const exit = await run.root.wait();
        await executor.waitIdle();
        await run.workspaceCompletion;
        await writeFile(`${rootDir}/completed.json`, JSON.stringify({ status: exit.status,
            workspace: (await session.getShared(`flow.run.${task.id}.workspace`))?.value }));
    } else if (phase === 'recover') await workspaces.reconcile('s');
    else await workspaces.prepare('s', { mode: 'worktree' });
} finally {
    kernel.kernel.dispose(); await executor.waitIdle(); await kernel.kernel.waitIdle(); await kernel.dispose();
    await files.dispose(); await manager.dispose();
}
process.disconnect?.();

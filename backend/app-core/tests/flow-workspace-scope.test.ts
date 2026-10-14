import { withWorkspaceScopeCleanup } from '../src/runtime/workspace-scope-cleanup';
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IDeviceDriver } from '@itookit/vfs-core';
import { DurableFlowExecutor } from '@itookit/llm-flow';
import { createKernelRuntime } from '../src/runtime/create-kernel-runtime';

it('selects the persisted Flow workspace in the shared runtime without a host-provided selector', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const acquired: string[] = [], closed: string[] = [];
    const files = async (identity: string) => ({ cwd: '/workspace', vfs: {
        readFile: async () => identity, writeFile: async () => {}, listFiles: async () => [],
    }, release: async () => { closed.push(`capabilities:${identity}`); } });
    const runtime = await createKernelRuntime({ systemFS: fs, llmDriver: {} as IDeviceDriver,
        storageResolver: { kind: 'test', resolve: async () => ({ fs, rootPath: '/sessions/s' }) }, recover: false,
        fileContextForSession: () => files('ordinary'),
        fileContextForScope: async (sessionId, scopeId) => { acquired.push(`${sessionId}:${scopeId}`); return files(scopeId); },
    });
    const executor = new DurableFlowExecutor({ kernel: runtime.kernel, plugins: runtime.dagPlugins,
        workspaceManager: withWorkspaceScopeCleanup({ prepare: async () => ({ directory: '/workspace',
            record: { directory: '/copy' }, finish: async () => { closed.push('workspace'); } }) }, runtime),
    });
    try {
        const session = await runtime.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        const run = await executor.submit('s', { runPolicy: { workspace: { mode: 'worktree' } },
            nodes: [{ id: 'gate', name: 'Gate', plugin: 'builtin.human', pluginVersion: '1.0.0',
                config: { requestId: 'go', prompt: 'Continue' }, inputs: {}, capabilities: [] }], edges: [] });
        await vi.waitFor(() => expect(run.nodes.has('gate')).toBe(true));
        const context = { sessionId: 's', taskId: run.nodes.get('gate')!.id, effectId: 'inspect',
            abortSignal: new AbortController().signal, grants: [] };
        const scope = await runtime.sessions.getForEffect!(context);
        const result = await scope.toolService.invoke({ toolId: 'Read', args: { file_path: '/workspace/file' } });
        expect(JSON.stringify(result)).toContain(run.root.id);
        expect(acquired).toEqual([`s:${run.root.id}`]);
        await session.deleteShared(`flow.run.${run.root.id}.workspace-lease`);
        await expect(runtime.sessions.getForEffect!({ ...context, effectId: 'later' })).rejects.toThrow('lease is unavailable');
        const gate = run.nodes.get('gate')!;
        await vi.waitFor(async () => expect((await gate.status()).task.interactions.go).toBeDefined());
        await gate.respond({ interactionId: 'go', value: 'done' });
        await run.root.wait();
        await vi.waitFor(() => expect(run.workspaceCompletion).toBeDefined());
        await run.workspaceCompletion;
        expect(closed).toEqual([`capabilities:${run.root.id}`, 'workspace']);
    } finally {
        runtime.kernel.dispose(); await executor.waitIdle(); await runtime.kernel.waitIdle();
        await runtime.dispose(); await manager.dispose();
    }
});

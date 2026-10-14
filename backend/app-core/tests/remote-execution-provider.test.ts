import { expect, it, vi } from 'vitest';
import { createRemoteExecutionProvider } from '../src/projects/execution/remote-provider';
import type { SessionFilesService } from '../src/vfs/session-files';
import type { RemoteFileSourceProvider } from '../src/projects/remote-mounts';
it('shares cwd, maps project grants and preserves session read-only attenuation', async () => {
    const order: string[] = [];
    const files = { inspect: async () => ({ state: 'active', mounts: [{ at: '/workspace', access: 'ro' }] }),
        acquire: async () => ({ cwd: '/workspace/src', vfs: {}, release: async () => { order.push('files'); } }) } as unknown as SessionFilesService;
    const process = vi.fn(async () => ({ nativeShell: {}, release: async () => { order.push('process'); } }));
    const provider = { process, capabilities: async () => ({ serverId: 'node', processEpoch: 'epoch', pathModel: 'virtual-root' }) } as unknown as RemoteFileSourceProvider;
    const owner = await createRemoteExecutionProvider(files, provider)!.acquire({ projectId: 'p', sessionId: 's',
        binding: { version: 2, mode: 'directory', connectionId: 'c', serverId: 'node', requiredIsolation: 'sandbox', authorizationRevision: 'rev' },
        connection: { endpoint: 'http://localhost', credentialRef: 'secret' },
        mounts: [{ mountId: 'root', at: '/', root: '/project', alias: 'docs', access: 'rw', endpoint: 'http://localhost', credentialRef: 'secret' }] });
    expect(process).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cwd: '/workspace/src',
        mounts: [{ alias: 'docs', path: 'project', at: '/workspace', access: 'ro' }] }));
    await owner.release(); expect(order).toEqual(['process', 'files']);
});

it('rejects empty or disabled Session grants before acquiring a remote process', async () => {
    const acquire = vi.fn(), process = vi.fn();
    const provider = { process, capabilities: vi.fn() } as unknown as RemoteFileSourceProvider;
    for (const record of [{ state: 'active', mounts: [] }, { state: 'disabled', mounts: [{ at: '/workspace', access: 'rw' }] }]) {
        const files = { inspect: async () => record, acquire } as unknown as SessionFilesService;
        await expect(createRemoteExecutionProvider(files, provider)!.acquire({ sessionId: 's' } as never)).rejects.toMatchObject({ code: 'ECAPABILITY' });
    }
    expect(acquire).not.toHaveBeenCalled(); expect(process).not.toHaveBeenCalled();
});

it('requires a virtual-root process namespace without acquiring files or a process', async () => {
    const acquire = vi.fn(), process = vi.fn();
    const binding = { version: 2 as const, mode: 'directory' as const, connectionId: 'c', serverId: 'node',
        requiredIsolation: 'sandbox' as const, authorizationRevision: 'rev' };
    const base = { sessionId: 's', binding, connection: { endpoint: 'http://localhost', credentialRef: 'secret' }, mounts: [] };
    for (const caps of [{ serverId: 'node', process: { exec: true }, terminal: { pty: false }, executionModel: 'sandbox',
            workspaceConsistency: 'isolated', readOnlyEnforcement: 'kernel-enforced' },
        { serverId: 'node', processEpoch: 'epoch', pathModel: 'host-mapped', process: { exec: true }, terminal: { pty: false },
            executionModel: 'sandbox', workspaceConsistency: 'isolated', readOnlyEnforcement: 'kernel-enforced' }]) {
        const files = { inspect: async () => ({ state: 'active', mounts: [{ at: '/workspace', access: 'rw' }] }), acquire } as unknown as SessionFilesService;
        const provider = { process, capabilities: async () => caps } as unknown as RemoteFileSourceProvider;
        await expect(createRemoteExecutionProvider(files, provider)!.acquire(base as never)).rejects.toMatchObject({ code: 'ECAPABILITY' });
    }
    expect(acquire).not.toHaveBeenCalled(); expect(process).not.toHaveBeenCalled();
});

it('retains the provider receiver when adapting instance methods', async () => {
    const files = { inspect: async () => ({ state: 'active', mounts: [{ at: '/workspace', access: 'rw' }] }),
        acquire: async () => ({ cwd: '/workspace', vfs: {}, release: async () => {} }) } as unknown as SessionFilesService;
    class Provider {
        private serverId = 'node';
        async capabilities() { return { serverId: this.serverId, processEpoch: 'epoch', pathModel: 'virtual-root' as const }; }
        async process() { expect(this.serverId).toBe('node'); return { nativeShell: {}, release: async () => {} }; }
    }
    const provider = new Provider() as unknown as RemoteFileSourceProvider;
    const owner = await createRemoteExecutionProvider(files, provider)!.acquire({ projectId: 'p', sessionId: 's',
        binding: { version: 2, mode: 'directory', connectionId: 'c', serverId: 'node', requiredIsolation: 'sandbox', authorizationRevision: 'rev' },
        connection: { endpoint: 'http://localhost', credentialRef: 'secret' }, mounts: [] });
    await owner.release();
});

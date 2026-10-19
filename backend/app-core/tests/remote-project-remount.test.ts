import { expect, it, vi } from 'vitest';
import { MemoryBackend, createFileSystemSource } from '@itookit/vfs-core';
import type { HarnessClient, HarnessProfile, ProjectClient, RemoteProject } from '@itookit/mindos-node-client';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { RemoteMountStore } from '../src/projects/remote-mount-store';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';

async function fixture() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'});
    const fs = await runtime.vfs.openFileSystem('/'), store = new RemoteMountStore(fs);
    const connection = {id: 'node', name: 'Node', endpoint: 'https://files.test', credentialRef: 'secret', projects: true};
    const grant = {...connection, connectionId: 'node', serverProjectId: 'native', serverProjectRevision: 1,
        at: '/', root: '/a', alias: 'docs', access: 'ro' as const, mountId: 'original'};
    await store.load(); await store.save({version: 1, revision: 1, connections: [connection], projects: {project: [grant]}});
    let project: RemoteProject = {id: 'native', name: 'Native', alias: 'docs', path: 'a', access: 'ro', revision: 1, mounts: []};
    const remount = vi.fn(async (_before: RemoteProject, access: 'ro' | 'rw') => project = {...project, access, revision: project.revision + 1});
    const close = vi.fn(async () => {}), before = vi.fn(async () => {}), after = vi.fn(async () => {});
    const client = {read: vi.fn(async () => project), roots: vi.fn(async () => ({roots: [{alias: 'docs', access: 'rw'}]})), remount, close} as unknown as ProjectClient;
    const remote = new ProjectRemoteMountService(fs, {setCredential() {}, projects: () => client,
        open: async () => createFileSystemSource({backend: new MemoryBackend(), viewId: 'remote', access: 'ro'}),
        dispose: async () => {}}, before, after);
    await remote.init();
    return {remote, store, remount, close, before, after, client, get: () => project,
        async dispose() { await remote.dispose(); await runtime.dispose(); }};
}

it('upgrades the registered root once and persists attenuation without changing project identity', async () => {
    const f = await fixture();
    try {
        await f.remote.remountProject('project', 'rw');
        expect(f.remount).toHaveBeenCalledOnce();
        expect(f.remote.list('project')[0]).toMatchObject({serverProjectId: 'native', connectionId: 'node', access: 'rw', serverProjectRevision: 2});
        expect(f.remote.list('project')[0].mountId).not.toBe('original');
        await f.remote.remountProject('project', 'ro');
        expect(f.remount).toHaveBeenCalledOnce(); expect(f.get().access).toBe('rw');
        expect(f.remote.list('project')[0].access).toBe('ro');
        await f.remote.remountProject('project', 'rw'); expect(f.remount).toHaveBeenCalledOnce();
        expect((await f.store.load())?.projects.project[0].access).toBe('rw');
        expect(f.before).toHaveBeenCalledTimes(3); expect(f.after).toHaveBeenCalledTimes(3);
    } finally { await f.dispose(); }
});

it('queries project models through the application service and closes every capability lookup', async () => {
    const f = await fixture();
    const profile: HarnessProfile = {id: 'native', kind: 'codex', projectRuntime: true, aliases: ['alias'], workspaces: [{id: 'w'}],
        capabilities: {create: true, history: true, resume: true, interrupt: true, interactions: true, models: true}};
    const catalog = {models: [{id: 'model', label: 'Model', reasoningEfforts: []}]};
    const close = vi.fn(async () => {}), models = vi.fn(async () => catalog);
    const client = {profiles: vi.fn(async () => ({epoch: 'e', profiles: [profile]})), models, close} as unknown as HarnessClient;
    vi.spyOn(f.remote, 'projectHarness').mockResolvedValue(client);
    try {
        expect(await f.remote.projectModels('project', 'alias')).toEqual(catalog);
        expect(models).toHaveBeenCalledWith('native', undefined, undefined); expect(close).toHaveBeenCalledOnce();
        profile.capabilities.models = false;
        expect(await f.remote.projectModels('project', 'alias')).toEqual({models: []}); expect(models).toHaveBeenCalledOnce();
        await expect(f.remote.projectModels('project', 'missing')).rejects.toMatchObject({code: 'ECAPABILITY'});
        expect(close).toHaveBeenCalledTimes(3);
    } finally {await f.dispose();}
});

it('retains the local readonly grant after a lost response and reconciles by reading before retrying', async () => {
    const f = await fixture();
    try {
        const apply = f.remount.getMockImplementation()!;
        f.remount.mockImplementationOnce(async (...args) => { await apply(...args); throw new Error('Response lost'); });
        await expect(f.remote.remountProject('project', 'rw')).rejects.toThrow('Response lost');
        expect(f.remote.list('project')[0].access).toBe('ro'); expect(f.get().access).toBe('rw');
        await f.remote.remountProject('project', 'rw');
        expect(f.remount).toHaveBeenCalledOnce(); expect(f.remote.list('project')[0].access).toBe('rw');
        expect(f.close).toHaveBeenCalledTimes(2);
    } finally { await f.dispose(); }
});

it('rejects busy projects and unsupported servers without changing the stored grant', async () => {
    const f = await fixture();
    try {
        const original = f.remote.list('project');
        f.before.mockRejectedValueOnce(new Error('Task running'));
        await expect(f.remote.remountProject('project', 'rw')).rejects.toThrow('Task running');
        expect(f.client.read).not.toHaveBeenCalled();
        f.client.remount = undefined;
        await expect(f.remote.remountProject('project', 'rw')).rejects.toMatchObject({code: 'ECAPABILITY'});
        vi.mocked(f.client.roots).mockResolvedValueOnce({roots: [{alias: 'docs', access: 'ro'}], execution: true, backend: 'bubblewrap'});
        await expect(f.remote.remountProject('project', 'rw')).rejects.toMatchObject({code: 'EROFS'});
        expect(f.remote.list('project')).toEqual(original); expect(f.after).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
});

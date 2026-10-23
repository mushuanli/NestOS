import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager } from '@itookit/vfs-core';
import type { HarnessClient, HarnessProfile } from '@itookit/mindos-node-driver';
import type { HarnessExecutionConnection } from '@itookit/kernel-adapters/contracts';
import type { ProjectRemoteMount } from '../src/projects/remote-mounts';
import { HarnessConnectionService } from '../src/projects/harness-connections';
import type { ProjectFolder } from '../src/projects/project-service';

let manager: IVFSManager;
afterEach(async () => { await manager?.dispose(); });
const definition: HarnessExecutionConnection = { id: 'execution', name: 'Remote worker', kind: 'harness',
    nodeConnectionId: 'node-connection', projectId: 'local-project', profileId: 'fixture' };
async function fixture() {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/'), authorization = { principalId: 'owner', anonymous: false, revision: 'a'.repeat(64) };
    const node = { id: 'node-connection', name: 'Node', endpoint: 'https://node.test', credentialRef: 'private-credential-reference', serverId: 'server', authorization };
    const mounts: ProjectRemoteMount[] = [{ ...node, authorization: structuredClone(authorization), connectionId: node.id, mountId: 'root', at: '/', alias: 'docs', root: '/allowed', access: 'rw',
        serverProjectId: 'server-project', serverProjectRevision: 2,
        capabilities: { fileRead: true, fileWrite: true, run: true, sessionRead: true, sessionControl: true } }];
    const profile: HarnessProfile = { id: 'fixture', kind: 'fixture', projectRuntime: true, workspaces: [{ id: 'server-project' }],
        capabilities: { create: true, resume: true, interrupt: true, history: true, interactions: true, models: true } };
    const clients: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const profiles = vi.fn(async () => ({ epoch: 'mutation-epoch', profiles: [structuredClone(profile)] }));
    const models = vi.fn(async () => ({ models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: [{ id: 'high', label: 'High' }] }] }));
    const remote = { list: () => structuredClone(mounts), resolveConnection: vi.fn(async () => structuredClone(node)),
        projectHarness: vi.fn(async () => { const client = { profiles, models, close: vi.fn(async () => {}) }; clients.push(client); return client as unknown as HarnessClient; }) };
    const service = new HarnessConnectionService(fs, remote);
    return { fs, service, remote, node, mounts, profile, profiles, clients, models };
}

it('persists target choices, freezes only grant identity and acquires an owned project-scoped client', async () => {
    const f = await fixture();
    expect((await f.service.save(definition, 0)).revision).toBe(1);
    const reloaded = new HarnessConnectionService(f.fs, f.remote), snapshot = (await reloaded.freeze('execution'))!;
    expect(snapshot).toMatchObject({ version: 1, revision: 1, project: { serverId: 'server', serverProjectId: 'server-project', serverProjectRevision: 2 } });
    expect(JSON.stringify(snapshot.project)).not.toMatch(/credential|endpoint|private/);
    expect((await reloaded.list())[0].connection).toEqual(definition);
    const acquired = await reloaded.acquire(snapshot);
    expect(f.remote.projectHarness).toHaveBeenCalledWith('local-project', { requireRegistered: true });
    expect(acquired).toMatchObject({ workspaceId: 'server-project', epoch: 'mutation-epoch', profile: { id: 'fixture' } });
    await acquired.release(); await acquired.release();
    expect(f.clients[0].close).toHaveBeenCalledOnce(); expect(f.clients[1].close).toHaveBeenCalledOnce();
});

it('uses per-target CAS and retains deletion revisions to prevent stale resurrection', async () => {
    const f = await fixture(), other = new HarnessConnectionService(f.fs, f.remote);
    await f.service.save(definition, 0);
    await expect(other.save({ ...definition, name: 'Stale' }, 0)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect((await other.remove('execution', 1)).revision).toBe(2);
    expect(await f.service.get('execution')).toBeUndefined(); expect(await f.service.list()).toEqual([]);
    await expect(f.service.save(definition, 0)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect((await f.service.save(definition, 2)).revision).toBe(3);
});

it('rejects configuration, mount, node and authorization drift before invoking a native session', async () => {
    const f = await fixture(); await f.service.save(definition, 0);
    const snapshot = (await f.service.freeze('execution'))!;
    f.mounts[0].access = 'ro';
    await expect(f.service.acquire(snapshot)).rejects.toMatchObject({ code: 'ECONFLICT' });
    f.mounts[0].access = 'rw'; f.node.authorization.revision = 'b'.repeat(64);
    await expect(f.service.acquire(snapshot)).rejects.toMatchObject({ code: 'EACCES' });
    f.node.authorization.revision = 'a'.repeat(64); f.node.serverId = 'other';
    await expect(f.service.acquire(snapshot)).rejects.toMatchObject({ code: 'ECAPABILITY' });
    f.node.serverId = 'server'; await f.service.save({ ...definition, name: 'Changed' }, 1);
    await expect(f.service.acquire(snapshot)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(f.remote.projectHarness).toHaveBeenCalledOnce();
});

it('rechecks authorization after profile discovery and closes a rejected acquisition', async () => {
    const f = await fixture(); await f.service.save(definition, 0);
    const snapshot = (await f.service.freeze('execution'))!;
    f.profiles.mockImplementationOnce(async () => { f.mounts[0].serverProjectRevision = 3; return { epoch: 'mutation-epoch', profiles: [f.profile] }; });
    await expect(f.service.acquire(snapshot)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(f.clients[1].close).toHaveBeenCalledOnce();
});

it('requires the scoped project workspace and execution capabilities instead of selecting another workspace', async () => {
    const f = await fixture(); await f.service.save(definition, 0);
    f.profile.workspaces = [{ id: 'unrelated' }];
    await expect(f.service.freeze('execution')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    f.profile.workspaces = [{ id: 'server-project' }]; f.profile.projectRuntime = false;
    await expect(f.service.freeze('execution')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    f.profile.projectRuntime = true; f.profile.capabilities.interrupt = false;
    await expect(f.service.freeze('execution')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect(f.clients.every(client => client.close.mock.calls.length === 1)).toBe(true);
});

it('keeps disabled or unavailable targets inactive and rejects secrets or invalid identities in definitions', async () => {
    const f = await fixture(); await f.service.save({ ...definition, enabled: false }, 0);
    expect(await f.service.freeze('execution')).toBeUndefined(); expect(f.remote.projectHarness).not.toHaveBeenCalled();
    await expect(f.service.save({ ...definition, apiKey: 'must-not-persist' } as never, 1)).rejects.toThrow('Invalid');
    await expect(f.service.save({ ...definition, id: '../escape' }, 0)).rejects.toThrow('identity');
    const unavailable = new HarnessConnectionService(f.fs); await unavailable.save({ ...definition, id: 'offline' }, 0);
    await expect(unavailable.freeze('offline')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect(await f.fs.meta.seq!.getEntry('/etc/execution/connections/execution.seq', 'connection')).not.toContain('must-not-persist');
});

it('validates configured native model selections through the advertised profile catalog', async () => {
    const f = await fixture(); await f.service.save({ ...definition, selection: { modelId: 'fixture-model', reasoningEffort: 'high' } }, 0);
    expect((await f.service.freeze('execution'))?.selection).toEqual({ modelId: 'fixture-model', reasoningEffort: 'high' });
    await f.service.save({ ...definition, selection: { modelId: 'missing' } }, 1);
    await expect(f.service.freeze('execution')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(f.models).toHaveBeenCalledTimes(2);
});

function project(id = 'local-project'): ProjectFolder {
    return { path: '/Remote', name: 'Remote project', parentPath: null, updatedAt: 0,
        project: { id, directory: `project:${id}`, source: { kind: 'remote' } } };
}

it('discovers safe project-scoped profiles on demand and closes every discovery client', async () => {
    const f = await fixture();
    expect(f.remote.projectHarness).not.toHaveBeenCalled();
    f.profiles.mockResolvedValueOnce({ epoch: 'epoch', profiles: [f.profile,
        { ...f.profile, id: 'raw', projectRuntime: false }, { ...f.profile, id: 'wrong-project', workspaces: [{ id: 'elsewhere' }] }] });
    expect(await f.service.targets([project()])).toEqual([{ nodeConnectionId: definition.nodeConnectionId,
        projectId: definition.projectId, projectName: 'Remote project', profiles: [{ id: 'fixture', kind: 'fixture' }], available: true }]);
    expect(f.clients[0].close).toHaveBeenCalledOnce();
    expect(f.remote.projectHarness).toHaveBeenCalledWith('local-project', { requireRegistered: true });
    expect(JSON.stringify(await f.service.targets([project()]))).not.toMatch(/credential|endpoint|private/);
});

it('preserves unavailable discovery entries without registering missing grants or leaking remote errors', async () => {
    const f = await fixture(); delete f.mounts[0].serverProjectId;
    expect(await f.service.targets([project()])).toMatchObject([{ available: false, profiles: [], errorCode: 'ECAPABILITY' }]);
    expect(f.remote.projectHarness).not.toHaveBeenCalled();
    f.mounts[0].serverProjectId = 'server-project';
    f.profiles.mockRejectedValueOnce(new Error('private-credential remote response'));
    const result = await f.service.targets([project()]);
    expect(result).toMatchObject([{ available: false, profiles: [], errorCode: 'UNAVAILABLE' }]);
    expect(JSON.stringify(result)).not.toContain('private'); expect(f.clients[0].close).toHaveBeenCalledOnce();
});

it('limits profile discovery to four concurrent projects and rejects grant drift', async () => {
    const f = await fixture(); let active = 0, maximum = 0;
    f.profiles.mockImplementation(async () => { active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5)); active--; return { epoch: 'epoch', profiles: [f.profile] }; });
    expect((await f.service.targets(Array.from({ length: 9 }, (_, index) => project(`project-${index}`))))
        .every(target => target.available)).toBe(true);
    expect(maximum).toBe(4); expect(f.clients.every(client => client.close.mock.calls.length === 1)).toBe(true);
    f.profiles.mockImplementationOnce(async () => { f.mounts[0].serverProjectRevision = 3; return { epoch: 'epoch', profiles: [f.profile] }; });
    expect(await f.service.targets([project()])).toMatchObject([{ available: false, profiles: [], errorCode: 'ECONFLICT' }]);
});

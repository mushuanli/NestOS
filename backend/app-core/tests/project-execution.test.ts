import { it, expect, vi } from 'vitest';
import { ProjectExecutionService } from '../src/projects/execution/service';
import type { ExecutionCapabilities, ProjectExecutionSources } from '../src/projects/execution/contracts';
import type { ProjectRemoteMount } from '../src/projects/remote-mounts';

function fixture() {
    const mounts: ProjectRemoteMount[] = [{ mountId: 'root', connectionId: 'c', at: '/', alias: 'docs', root: '/', access: 'rw',
        credentialRef: 'secret', endpoint: 'http://localhost' }];
    const caps: ExecutionCapabilities = { serverId: 'node', process: { exec: true }, terminal: { pty: false }, executionModel: 'sandbox',
        workspaceConsistency: 'isolated', readOnlyEnforcement: 'kernel-enforced' };
    const remote = { list: () => structuredClone(mounts), executionCapabilities: vi.fn(async () => caps),
        connection: () => ({ endpoint: 'http://localhost', credentialRef: 'secret' }) } satisfies ProjectExecutionSources;
    const release = vi.fn(async () => {}), acquire = vi.fn(async (_input: unknown) => ({ cwd: '/workspace', nativeShell: {} as never, release }));
    const service = new ProjectExecutionService(remote, { acquire });
    return { mounts, caps, release, acquire, service, remote };
}

it('automatically supplies remote execution for Session and scope consumers without a stored toggle', async () => {
    const f = fixture();
    await f.service.acquire('p', 'session');
    await f.service.acquire('p', 'session', 'scope');
    expect(f.acquire).toHaveBeenCalledTimes(2);
    expect(f.acquire).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: 'scope',
        binding: expect.objectContaining({ version: 2, mode: 'directory', serverId: 'node', requiredIsolation: 'sandbox' }) }));
});

it('keeps file-only access when the server disables execution and rechecks on acquisition', async () => {
    const f = fixture(); f.caps.process.exec = false;
    expect(await f.service.acquire('p', 's')).toBeUndefined(); expect(f.acquire).not.toHaveBeenCalled();
    f.caps.process.exec = true;
    expect(await f.service.acquire('p', 's')).toHaveProperty('nativeShell');
});

it('does not assign a remote shell to a local project with an extra remote mount', async () => {
    const f = fixture(); f.mounts[0].at = '/reference';
    expect(await f.service.acquire('p', 's')).toBeUndefined();
    expect(f.remote.executionCapabilities).not.toHaveBeenCalled(); expect(f.acquire).not.toHaveBeenCalled();
});

it('retains sandbox and single-node requirements without a workbench permission switch', async () => {
    const f = fixture(); f.caps.executionModel = 'trusted-cooperative-host';
    await expect(f.service.acquire('p', 's')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    f.caps.executionModel = 'sandbox'; f.mounts.push({ ...f.mounts[0], mountId: 'ref', at: '/ref', connectionId: 'other' });
    await expect(f.service.acquire('p', 's')).rejects.toMatchObject({ code: 'EXMOUNT' });
    expect(f.acquire).not.toHaveBeenCalled();
});

it('releases a prepared context when directory grants change during acquisition', async () => {
    const f = fixture();
    f.acquire.mockImplementationOnce(async () => { f.mounts[0].root = '/changed'; return { cwd: '/', nativeShell: {} as never, release: f.release }; });
    await expect(f.service.acquire('p', 's')).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(f.release).toHaveBeenCalledOnce();
});

it('requires process identity and enforced readonly grants', async () => {
    const f = fixture(); f.caps.serverId = null;
    await expect(f.service.acquire('p', 's')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    f.caps.serverId = 'node'; f.mounts[0].access = 'ro'; f.caps.readOnlyEnforcement = 'best-effort';
    await expect(f.service.acquire('p', 's')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect(f.acquire).not.toHaveBeenCalled();
});

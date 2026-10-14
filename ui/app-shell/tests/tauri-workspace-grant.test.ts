import { expect, it, vi } from 'vitest';
import type { ApplicationPlatformServices, FilesRecord } from '@itookit/app-core';
import { resolveTauriWorkspaceGrant } from '../../../apps/tauri-app/src/shell/workspace-grant';

function setup(sourceId = 'admin-home') {
    const record: FilesRecord = { state: 'active', revision: 4, cwd: '/workspace', mounts: [
        { mountId: 'work', sourceId, root: '/project', at: '/workspace', access: 'rw' },
    ] };
    const inspect = vi.fn(async () => record);
    const processMounts = vi.fn(async () => [{ sourceId, at: '/workspace', access: 'rw' as const,
        directory: sourceId === 'admin-home' ? '/home/admin/project' : '/external/project' }]);
    const services = { sessionFiles: { inspect }, directoryMounts: { processMounts } } as unknown as ApplicationPlatformServices;
    return { record, inspect, processMounts, services };
}

it.each(['admin-home', 'external'])('freezes the %s grant and translates only the managed home path', async sourceId => {
    const { services } = setup(sourceId);
    expect(await resolveTauriWorkspaceGrant(services, 's', '/data/')).toEqual({
        sessionId: 's', revision: 4, mountId: 'work', sourceId, root: '/project', at: '/workspace',
        repository: sourceId === 'admin-home' ? '/data/home/admin/project' : '/external/project',
    });
});

it('rejects disabled, ambiguous and non-root working directories before resolving native paths', async () => {
    for (const change of [
        (record: FilesRecord) => { record.state = 'disabled'; },
        (record: FilesRecord) => { record.cwd = '/workspace/subdir'; },
        (record: FilesRecord) => { record.mounts.push({ ...record.mounts[0], mountId: 'other', at: '/other' }); },
        (record: FilesRecord) => { record.mounts[0].access = 'ro'; },
    ]) {
        const { services, record, processMounts } = setup();
        change(record);
        await expect(resolveTauriWorkspaceGrant(services, 's', '/data')).rejects.toThrow('one writable mount');
        expect(processMounts).not.toHaveBeenCalled();
    }
});

it('rejects native mappings that disagree with the file source', async () => {
    const { services, processMounts } = setup();
    processMounts.mockResolvedValue([{ sourceId: 'another', at: '/workspace', access: 'rw', directory: '/other' }]);
    await expect(resolveTauriWorkspaceGrant(services, 's', '/data')).rejects.toThrow('does not match');
});

it('rejects an authorization change while native mappings are being resolved', async () => {
    const { services, inspect, record } = setup();
    inspect.mockResolvedValueOnce(record).mockResolvedValue({ ...record, revision: 5 });
    await expect(resolveTauriWorkspaceGrant(services, 's', '/data')).rejects.toThrow('authorization changed');
});

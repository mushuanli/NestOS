import {expect, it, vi} from 'vitest';
import type {ProjectFolder, ProjectService} from '@itookit/app-contracts/services';
import {remoteDraftCatalog} from '../src/projects/remote-draft-catalog';

function fixture() {
    const project = {path: 'folder', name: 'Project', project: {id: 'project'}} as ProjectFolder;
    const profiles = vi.fn(async () => ({profiles: [{id: 'codex', kind: 'codex', projectRuntime: true, capabilities: {create: true, models: true}}]}));
    const close = vi.fn(async () => {}), projectModels = vi.fn(async () => ({models: []})), forFolder = vi.fn(async () => project);
    const projectHarness = vi.fn(async () => ({profiles, close}));
    const projects = {forFolder, remoteMounts: {list: () => [{at: '/', connectionId: 'node', serverProjectId: 'native', access: 'rw'}],
        connectionName: () => 'Node', projectHarness, projectModels}} as unknown as ProjectService;
    return {catalog: remoteDraftCatalog(projects, 'folder', project), profiles, close, projectModels, forFolder, projectHarness};
}
it('uses the known project and discovered profiles for the next model read without reopening the harness', async () => {
    const f = fixture(), [executor] = await f.catalog.list(); await f.catalog.models(executor.id);
    expect(f.forFolder).not.toHaveBeenCalled(); expect(f.projectHarness).toHaveBeenCalledOnce(); expect(f.profiles).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.projectModels).toHaveBeenCalledWith('project', 'codex', {timeoutMs: 30000});
});
it('invalidates a removed profile when the executor list is explicitly refreshed', async () => {
    const f = fixture(), [executor] = await f.catalog.list(); f.profiles.mockResolvedValueOnce({profiles: []});
    await f.catalog.list(); expect(await f.catalog.models(executor.id)).toEqual({models: []}); expect(f.projectModels).not.toHaveBeenCalled();
    expect(f.forFolder).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledTimes(2);
});
it('preserves discovery failures and closes the reader instead of pretending the catalog is empty', async () => {
    const f = fixture(), failure = new TypeError('Load failed'); f.profiles.mockRejectedValueOnce(failure);
    await expect(f.catalog.list()).rejects.toBe(failure); expect(f.close).toHaveBeenCalledOnce();
});

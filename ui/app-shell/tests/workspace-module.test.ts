import { expect, it, vi } from 'vitest';
import { createWorkspaceModule, restoreWorkspaceResource } from '../src/workspaces/module';

function controller() {
    return { start: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
        openResource: vi.fn(async (_id: string) => {}), getActiveResourceId: () => '/active' };
}

it('releases module-owned resources once across dynamic removal and application shutdown', async () => {
    const workbench = controller(), release = vi.fn(async () => { await workbench.destroy(); });
    const module = createWorkspaceModule(workbench, release);
    await Promise.all([module.workbench.destroy(), module.dispose(), module.dispose()]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(workbench.destroy).toHaveBeenCalledTimes(1);
    expect(module.workbench.createResource).toBeUndefined();
});

it('preserves cleanup failure for all owners without rerunning partial disposal', async () => {
    const failure = new Error('release failed'), dispose = vi.fn(async () => { throw failure; });
    const module = createWorkspaceModule(controller(), dispose);
    await expect(module.workbench.destroy()).rejects.toBe(failure);
    await expect(module.dispose()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
});

it('restores bookmarks through the declared capability without changing strict open behavior', async () => {
    const failure = new Error('stale resource'), workbench = controller();
    workbench.openResource.mockRejectedValue(failure);
    const restoreResource = vi.fn(async () => {});
    const module = createWorkspaceModule({ ...workbench, restoreResource });
    await restoreWorkspaceResource(module.workbench, '/missing');
    expect(restoreResource).toHaveBeenCalledWith('/missing');
    expect(workbench.openResource).not.toHaveBeenCalled();
    await expect(module.workbench.openResource('/missing')).rejects.toBe(failure);
    await expect(restoreWorkspaceResource(createWorkspaceModule(workbench).workbench, '/missing')).rejects.toBe(failure);
});

it('forwards visibility without destroying the cached workspace', async () => {
    const workbench = controller(), setVisible = vi.fn(async (_visible: boolean) => {});
    const module = createWorkspaceModule({ ...workbench, setVisible });
    await module.workbench.setVisible?.(false); await module.workbench.setVisible?.(true);
    expect(setVisible.mock.calls).toEqual([[false], [true]]);
    expect(workbench.destroy).not.toHaveBeenCalled();
    await module.dispose();
});

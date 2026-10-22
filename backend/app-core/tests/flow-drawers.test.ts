import { afterEach, expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../src/host/application-services';
import { createApplicationClient } from '../src/host/application-client';
import { ToolboxResources } from '../src/configuration/toolbox-resources';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { externalFlowLibrary, externalFlowDrawers } from './fixtures/flow-library';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(groupShared = true) {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const toolbox = await client.backend.toolboxView();
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: externalFlowLibrary() });
    const resources = toolbox.resources;
    if (groupShared) await resources.drawers.assign([{ path: '/flows/shared-child.flow', name: 'Reusable flows' }]);
    await resources.navigation();
    const restore = () => runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: externalFlowLibrary() });
    return { runtime, client, toolbox, resources, restore };
}

it('keeps explicit grouping of a recovered shared Flow without moving files or grouping its entries', async () => {
    const { runtime, resources, restore } = await setup();
    await runtime.flowEngine.engine.driver.delete(['/shared-child.flow']);
    expect(await restore()).toBe(1);
    await resources.navigation();
    expect(resources.drawers.forPath('/flows/shared-child.flow')).toMatchObject({ name: 'Reusable flows', paths: ['/flows/shared-child.flow'] });
    expect(resources.drawers.forPath('/flows/second-entry.flow')?.id).toBe('/drawers/ungrouped-flows');
    expect(resources.drawers.forPath('/flows/first-entry.flow')?.id).toBe('/drawers/ungrouped-flows');
    expect(await runtime.flowEngine.engine.driver.exists('/shared-child.flow')).toBe(true);
    expect(await runtime.flowEngine.engine.driver.exists('/Reusable flows')).toBe(false);
});

it('keeps manual grouping and group deletion through recovery and a fresh client', async () => {
    const { runtime, resources, restore } = await setup();
    await resources.drawers.assign([{ path: '/flows/shared-child.flow', name: 'My reusable flows' }]);
    await restore();
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const fresh = await client.backend.toolboxView();
    expect(fresh.resources.drawers.forPath('/flows/shared-child.flow')?.name).toBe('My reusable flows');
    await fresh.resources.drawers.assign([{ path: '/flows/shared-child.flow', name: 'Reusable flows' }]);
    await fresh.resources.navigation();
    await fresh.resources.drawers.remove(fresh.resources.drawers.forPath('/flows/shared-child.flow')!);
    await restore(); await fresh.resources.navigation();
    expect(fresh.resources.drawers.forPath('/flows/shared-child.flow')?.id).toBe('/drawers/ungrouped-flows');
});

it('exports an injected default Flow drawer without prior navigation and persists it for a remapped Flow', async () => {
    const { runtime, toolbox, resources } = await setup(false);
    const cold = new ToolboxResources(resources.sources, runtime.agentService, runtime.commandBus,
        await runtime.vfs.openFileSystem('/etc'), undefined, externalFlowDrawers());
    const archive = await cold.export(['/flows/shared-child.flow']);
    expect(JSON.parse(archive).entries[0].drawer).toBe('Reusable flows');
    const [copy] = await resources.import(archive); await resources.navigation();
    expect(copy).not.toBe('/flows/shared-child.flow');
    expect(resources.drawers.forPath(copy)?.name).toBe('Reusable flows');
    await toolbox.dispose();
    const next = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => next.close());
    const reloaded = await next.backend.toolboxView();
    expect(reloaded.resources.drawers.forPath(copy)?.name).toBe('Reusable flows');
});

it('persists and round trips user drawers for editable toolbox categories and empty drawers', async () => {
    const { runtime, resources } = await setup(false);
    const paths = [];
    for (const kind of ['agents', 'flows', 'skills', 'prompts', 'mcp'] as const) {
        paths.push(await resources.createInDrawer(kind, 'User ' + kind, 'Reusable ' + kind));
    }
    await resources.navigation();
    const archive = await resources.export(paths, [{ kind: 'flows', name: 'Empty flows' }]);
    expect(JSON.parse(archive).entries.map((entry: { drawer: string }) => entry.drawer)).toEqual([
        'Reusable agents', 'Reusable flows', 'Reusable skills', 'Reusable prompts', 'Reusable mcp',
    ]);
    const copies = await resources.import(archive); await resources.navigation();
    for (const copy of copies) expect(resources.drawers.forPath(copy)?.name).toBe('Reusable ' + copy.split('/')[1]);
    const next = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => next.close());
    const reloaded = await next.backend.toolboxView();
    for (const copy of copies) expect(reloaded.resources.drawers.forPath(copy)?.name).toBe('Reusable ' + copy.split('/')[1]);
    expect(reloaded.resources.drawers.list('flows')).toContainEqual(expect.objectContaining({ name: 'Empty flows', paths: [] }));
});

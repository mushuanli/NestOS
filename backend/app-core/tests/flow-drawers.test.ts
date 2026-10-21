import { afterEach, expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../src/host/application-services';
import { createApplicationClient } from '../src/host/application-client';
import { ToolboxResources } from '../src/configuration/toolbox-resources';
import { createMindosFlowDrawers } from '../src/presets/flow-library';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const toolbox = await client.backend.toolboxView();
    return { runtime, client, toolbox, resources: toolbox.resources, files: await client.backend.initialFiles() };
}

it('groups a recovered shared Flow without moving its file or changing entry Flow groups', async () => {
    const { runtime, resources, files } = await setup();
    await runtime.flowEngine.engine.driver.delete(['/anki-build.flow']);
    expect(await files.restore(['flow:anki-build'])).toEqual([{ id: 'flow:anki-build', status: 'restored' }]);
    await resources.navigation();
    expect(resources.drawers.forPath('/flows/anki-build.flow')).toMatchObject({ name: '子流程', paths: ['/flows/anki-build.flow'] });
    for (const path of ['/flows/anki-generate.flow', '/flows/anki-from-image.flow']) {
        expect(resources.drawers.forPath(path)?.id).toBe('/drawers/ungrouped-flows');
    }
    expect(await runtime.flowEngine.engine.driver.exists('/anki-build.flow')).toBe(true);
    expect(await runtime.flowEngine.engine.driver.exists('/子流程')).toBe(false);
});

it('keeps manual grouping and default group deletion through recovery and a fresh client', async () => {
    const { runtime, resources, files } = await setup();
    await resources.drawers.assign([{ path: '/flows/anki-build.flow', name: 'My reusable flows' }]);
    await files.restore(['flow:anki-build']);
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const fresh = await client.backend.toolboxView();
    expect(fresh.resources.drawers.forPath('/flows/anki-build.flow')?.name).toBe('My reusable flows');
    await fresh.resources.drawers.assign([{ path: '/flows/anki-build.flow', name: '子流程' }]);
    await fresh.resources.navigation();
    await fresh.resources.drawers.remove(fresh.resources.drawers.forPath('/flows/anki-build.flow')!);
    await files.restore(['flow:anki-build']); await fresh.resources.navigation();
    expect(fresh.resources.drawers.forPath('/flows/anki-build.flow')?.id).toBe('/drawers/ungrouped-flows');
});

it('exports the default Flow drawer without a prior navigation and restores it for a remapped Flow', async () => {
    const { runtime, toolbox, resources } = await setup();
    const cold = new ToolboxResources(resources.sources, runtime.agentService, runtime.commandBus,
        await runtime.vfs.openFileSystem('/etc'), undefined, createMindosFlowDrawers());
    const archive = await cold.export(['/flows/anki-build.flow']);
    expect(JSON.parse(archive).entries[0].drawer).toBe('子流程');
    const [copy] = await resources.import(archive); await resources.navigation();
    expect(copy).not.toBe('/flows/anki-build.flow');
    expect(resources.drawers.forPath(copy)?.name).toBe('子流程');
    await toolbox.dispose();
    const next = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => next.close());
    const reloaded = await next.backend.toolboxView();
    expect(reloaded.resources.drawers.forPath(copy)?.name).toBe('子流程');
});

it('persists and round trips user drawers for editable toolbox categories and empty drawers', async () => {
    const { runtime, resources } = await setup();
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

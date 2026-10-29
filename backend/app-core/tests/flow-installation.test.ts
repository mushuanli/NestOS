import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {FlowCommand, type FlowDraft, type FlowRevision} from '@itookit/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {FlowInstallationService} from '../src/configuration/flow-installation';
import {FlowToolPackages} from '../src/configuration/flow-tool-packages';
import {bindLocalApplicationServices} from '../src/host/application-services';
import {createApplicationClient} from '../src/host/application-client';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
const template = (id = 'installable'): FlowDraft => ({id: id as never, name: 'Installable', draftVersion: 1, updatedAt: 0, layout: {}, edges: [],
    parameters: [{name: 'body', type: 'string', required: true, default: 'Hello'}],
    toolDependencies: [{id: 'fixture.write', version: '1'}],
    nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', config: {value: '${param.body}'}, inputs: {}}]});

async function setup() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const tools = new Map<string, {id: string; version: string; enabled: boolean}>();
    const ensure = vi.fn(async (dependencies: Array<{id: string; version?: string}>) => ({tools: dependencies.map(item => {
        tools.set(item.id, {id: item.id, version: item.version ?? '1', enabled: true}); return {...item, status: 'ready' as const};
    })}));
    const packages = new FlowToolPackages({getToolMeta: id => tools.get(id) as never}, {ensure});
    const installations = new FlowInstallationService(runtime.commandBus, packages); cleanup.push(() => installations.close());
    return {runtime, installations, tools, ensure};
}

it('automatically ensures declared tools and reports parameter configuration without persisting fabricated defaults', async () => {
    const f = await setup(), flow = template();
    flow.parameters![0] = {...flow.parameters![0], default: undefined};
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const before = await f.runtime.commandBus.execute(FlowCommand.DraftLoad, {id: flow.id});
    expect((await f.installations.check(flow.id)).status).toBe('missingTools'); expect(f.ensure).not.toHaveBeenCalled();
    const report = await f.installations.ensure(flow.id);
    expect(f.ensure).toHaveBeenCalledWith([{id: 'fixture.write', version: '1'}]);
    expect(report.status).toBe('needsConfiguration'); expect(report.parameters).toContainEqual(expect.objectContaining({code: 'missing-parameter'}));
    expect(await f.runtime.commandBus.execute(FlowCommand.DraftLoad, {id: flow.id})).toEqual(before);
});

it('checks the preserved user declaration instead of reinstalling a new product template', async () => {
    const f = await setup(), flow = template(); await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const draft = await f.runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: flow.id});
    await f.runtime.commandBus.execute(FlowCommand.DraftSave, {draft: {...draft, name: 'User draft', toolDependencies: [{id: 'user.tool', version: '2'}]}, expectedDraftVersion: draft.draftVersion});
    const published = await f.runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, {id: flow.id});
    expect(await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [{...flow, toolDependencies: [{id: 'new-product.tool', version: '3'}]}]})).toBe(0);
    expect((await f.installations.ensure(flow.id)).tools).toMatchObject([{id: 'user.tool', version: '2', status: 'ready'}]);
    expect(await f.runtime.commandBus.execute(FlowCommand.RevisionGet, {id: flow.id})).toEqual(published);
});

it('uses static calls and inline functions as compatibility dependencies without evaluating dynamic tool names', async () => {
    const f = await setup(), flow = template(); delete flow.toolDependencies;
    flow.parameters = [{name: 'toolName', type: 'string', default: 'private tool identity'}];
    flow.nodes = [{...flow.nodes[0], plugin: 'builtin.tool', config: {toolId: 'fixture.direct', toolVersion: '1', args: {}}},
        {...flow.nodes[0], id: 'dynamic' as never, plugin: 'builtin.tool', config: {toolId: '${param.toolName}', toolVersion: '1', args: {}}}];
    flow.functions = [{...template('child'), toolDependencies: [{id: 'fixture.child', version: '2'}]}];
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    expect((await f.installations.ensure(flow.id)).tools.map(item => item.id).sort()).toEqual(['fixture.child', 'fixture.direct']);
});

it('returns missing and version failure details and rejects executable paths in dependency declarations', async () => {
    const f = await setup(), flow = template(); await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const unconfigured = new FlowInstallationService(f.runtime.commandBus, new FlowToolPackages({getToolMeta: () => undefined}));
    expect(await unconfigured.ensure(flow.id)).toMatchObject({status: 'missingTools', tools: [{id: 'fixture.write', status: 'missing', code: 'TOOL_NOT_REGISTERED'}]});
    f.tools.set('fixture.write', {id: 'fixture.write', version: 'old', enabled: true});
    expect(await f.installations.check(flow.id)).toMatchObject({status: 'failed', tools: [{code: 'TOOL_VERSION_MISMATCH'}]});
    const invalid = template('untrusted'); invalid.toolDependencies = [{id: 'fixture.write', modulePath: '/tmp/arbitrary.mjs'}] as never;
    await expect(f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [invalid]})).rejects.toThrow('Tool dependencies');
});

it('recovers dependency details and retries without rewriting existing system resources', async () => {
    const f = await setup(), client = createApplicationClient(bindLocalApplicationServices(f.runtime)); cleanup.push(() => client.close());
    const initial = await client.backend.initialFiles(), before = await f.runtime.commandBus.execute(FlowCommand.DraftLoad, {id: 'anki-generate'});
    const published = await f.runtime.commandBus.execute(FlowCommand.RevisionGet, {id: 'anki-generate'});
    const reports = await initial.prepareDependencies(['flow:anki-generate']);
    expect(reports).toHaveLength(1); expect(reports[0].status).toBe('missingTools');
    expect(reports[0].tools.map(tool => tool.id)).toContain('anki.package');
    expect(await initial.prepareDependencies(['flow:anki-generate'])).toEqual(reports);
    expect(await f.runtime.commandBus.execute(FlowCommand.RevisionGet, {id: 'anki-generate'})).toEqual(published);
    expect(await f.runtime.commandBus.execute(FlowCommand.DraftLoad, {id: 'anki-generate'})).toEqual(before);
});

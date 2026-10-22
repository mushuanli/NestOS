import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import type { AgentDefinition, AgentExecution } from '@itookit/kernel-adapters/contracts';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../src/host/application-services';
import { createApplicationClient } from '../src/host/application-client';
import { createChatConfigurationView } from '../src/configuration/chat-configuration';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { externalFlow, standaloneFlow } from './fixtures/flow-library';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const toolbox = await client.backend.toolboxView();
    return { runtime, resources: toolbox.resources };
}
const agent = (execution: AgentExecution = { kind: 'flow', flowId: 'generic-flow' }): AgentDefinition => ({
    id: 'flow-agent', name: 'Flow entry', type: 'workflow', config: {}, execution,
});
async function publish(runtime: Awaited<ReturnType<typeof setup>>['runtime'], definition = externalFlow('generic-flow')) {
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [definition] });
}

it('disables a deleted Flow binding without changing its Agent source and re-enables it after restoration', async () => {
    const { runtime, resources } = await setup(); await publish(runtime);
    await runtime.agentService.saveAgent(agent({ kind: 'flow', flowId: 'generic-flow', parameters: { format: 'plain' } }));
    const resource = runtime.agentService.getAgentResourceId('flow-agent')!;
    const original = await runtime.agentService.engine.driver.readContent(resource, { encoding: 'utf-8' });
    expect(JSON.parse(original)).not.toHaveProperty('availability');
    expect(await runtime.agentService.getAgentConfig('flow-agent')).toMatchObject({ availability: { status: 'ready' } });
    const view = await createChatConfigurationView(runtime.agentService); cleanup.push(() => view.dispose());
    expect(view.getConfigurationSnapshot().agents.find(item => item.id === 'flow-agent')).toMatchObject({ execution: { kind: 'flow', flowId: 'generic-flow' } });
    await runtime.flowEngine.engine.driver.delete(['/generic-flow.flow']);
    await vi.waitFor(() => expect(runtime.agentService.findAgent('flow-agent')).toMatchObject({ availability: { status: 'disabled', reason: 'flow-missing' } }));
    await vi.waitFor(() => expect(view.getConfigurationSnapshot().agents.find(item => item.id === 'flow-agent')?.availability?.reason).toBe('flow-missing'));
    expect((await resources.navigation()).descriptions.get('agents/flow-agent')?.availability?.status).toBe('disabled');
    expect(await runtime.agentService.engine.driver.readContent(resource, { encoding: 'utf-8' })).toBe(original);
    await publish(runtime);
    await vi.waitFor(() => expect(runtime.agentService.listAgents().find(item => item.id === 'flow-agent')?.availability?.status).toBe('ready'));
    expect(await runtime.agentService.engine.driver.readContent(resource, { encoding: 'utf-8' })).toBe(original);
});

it('distinguishes unpublished, missing pinned revisions and malformed Flow files', async () => {
    const { runtime } = await setup();
    await runtime.commandBus.execute(FlowCommand.DraftCreate, { id: 'generic-flow', name: 'Draft only' });
    await runtime.agentService.saveAgent(agent());
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.availability?.reason).toBe('flow-unpublished');
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: 'generic-flow' });
    await runtime.commandBus.execute(FlowCommand.RevisionCreate, { draftId: draft.id, expectedDraftVersion: draft.draftVersion });
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.availability?.status).toBe('ready');
    await runtime.agentService.saveAgent(agent({ kind: 'flow', flowId: 'generic-flow', revision: 99 }));
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.availability?.reason).toBe('flow-revision-missing');
    await runtime.flowEngine.engine.driver.writeContent('/generic-flow.flow', '{invalid JSON');
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.availability?.reason).toBe('flow-invalid');
});

it('strips caller-provided availability and returns detached execution snapshots', async () => {
    const { runtime } = await setup(); await publish(runtime);
    await runtime.agentService.saveAgent({ ...agent(), availability: { status: 'disabled', reason: 'flow-missing' } });
    const loaded = (await runtime.agentService.getAgentConfig('flow-agent'))!;
    expect(loaded.availability?.status).toBe('ready');
    loaded.availability!.status = 'disabled';
    expect(runtime.agentService.findAgent('flow-agent')?.availability?.status).toBe('ready');
    if (loaded.execution?.kind === 'flow') loaded.execution.flowId = 'changed-copy';
    expect(runtime.agentService.findAgent('flow-agent')?.execution).toMatchObject({ flowId: 'generic-flow' });
    const source = await runtime.agentService.engine.driver.readContent(runtime.agentService.getAgentResourceId('flow-agent')!, { encoding: 'utf-8' });
    expect(JSON.parse(source)).not.toHaveProperty('availability');
});

it('checks availability against the host plugin catalog instead of only built-in nodes', async () => {
    const { runtime } = await setup(), registry = runtime.kernel.dagPlugins;
    registry.register({ manifest: { ...registry.getManifest('builtin.transform', '1.0.0')!, id: 'custom.transform' },
        runtime: () => registry.loadRuntime('builtin.transform', '1.0.0') });
    const definition = externalFlow('generic-flow'); definition.nodes[0].plugin = 'custom.transform';
    await publish(runtime, definition); await runtime.agentService.saveAgent(agent());
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.availability?.status).toBe('ready');
});

it.each([undefined, 1])('keeps a published binding ready while its editable draft is incomplete (revision=%s)', async revision => {
    const { runtime } = await setup(); await publish(runtime);
    await runtime.agentService.saveAgent(agent({ kind: 'flow', flowId: 'generic-flow', ...(revision ? { revision } : {}) }));
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: 'generic-flow' });
    const edited = await runtime.commandBus.execute<{ valid: boolean }>(FlowCommand.DraftSave, {
        draft: { ...draft, nodes: [{ ...draft.nodes[0], plugin: 'unavailable-during-edit' }] }, expectedDraftVersion: draft.draftVersion,
    });
    expect(edited.valid).toBe(false);
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.availability?.status).toBe('ready');
    const id = await runtime.sessionRepository.createSession('Published Agent');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Use the published definition', files: [], agentId: 'flow-agent',
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'flow-agent', mode: 'agent' } } });
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds[0]?.status).toBe('completed'));
    const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
    expect(rounds[0].flow?.revision).toBe(1);
    const tasks = await runtime.kernel.kernel.listSessionTasks(id);
    expect(tasks.filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
    expect(tasks.filter(task => task.labels?.kind === 'flow-root')[0].status).toBe('succeeded');
    expect(tasks.flatMap(task => Object.values(task.effects))).toEqual([]);
});

it('exports a pinned Flow snapshot and its global dependencies, then imports a ready Agent with remapped identities', async () => {
    const source = await setup(), target = await setup();
    await publish(source.runtime, externalFlow('external-dependency'));
    const first = await source.runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: 'external-dependency' });
    const { draft: second } = await source.runtime.commandBus.execute<{ draft: FlowDraft }>(FlowCommand.DraftSave, {
        draft: { ...first, name: 'Published dependency v2' }, expectedDraftVersion: first.draftVersion,
    });
    await source.runtime.commandBus.execute(FlowCommand.RevisionCreate, { draftId: second.id, expectedDraftVersion: second.draftVersion });
    const definition = standaloneFlow();
    (definition.nodes[0].config as Record<string, unknown>).revision = 1;
    (definition.functions![0].nodes[0].config as Record<string, unknown>).revision = 1;
    definition.functions![0].functions![0].id = 'external-dependency' as never;
    (definition.functions![0].nodes[0].config as Record<string, unknown>).flowId = 'external-dependency';
    definition.nodes.push({ id: 'global', name: 'Global dependency', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
        config: { flowId: 'external-dependency', revision: 2, parameters: {} } });
    await publish(source.runtime, definition);
    await source.runtime.agentService.saveAgent(agent({ kind: 'flow', flowId: definition.id, revision: 1,
        parameters: { prompt: 'runtime prompt', detail: 2 }, connectionBindings: { text: 'model' } }));
    const path = '/agents' + source.runtime.agentService.getAgentResourceId('flow-agent');
    const archive = await source.resources.export([path]);
    const entries = JSON.parse(archive).entries;
    expect(entries.map((entry: { kind: string }) => entry.kind)).toEqual(['agents', 'flows', 'flows']);
    expect(entries[0].data).not.toHaveProperty('availability');
    expect(entries[2].data.name).toBe('Published dependency v2');
    const imported = await target.resources.import(archive), agentPath = imported.find(item => item.startsWith('/agents/'))!;
    const importedAgent = (await target.runtime.agentService.getAgents()).find(item => '/agents' + target.runtime.agentService.getAgentResourceId(item.id) === agentPath)!;
    expect(importedAgent.execution).toMatchObject({ kind: 'flow', revision: 1, parameters: { prompt: 'runtime prompt', detail: 2 } });
    expect(importedAgent.availability?.status).toBe('ready');
    const binding = importedAgent.execution as Extract<AgentExecution, { kind: 'flow' }>;
    expect(binding.flowId).not.toBe(definition.id);
    const master = await target.runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: binding.flowId });
    const globalId = (master.nodes.find(node => node.id === 'global')!.config as Record<string, unknown>).flowId;
    expect(globalId).not.toBe('external-dependency'); expect(master.dependencyLocks?.global.revision).toBe(1);
    expect(master.functions![0].functions![0].id).toBe('external-dependency');
    expect(master.functions![0].revision).toBe(1);
    expect(master.functions![0].functions![0].revision).toBe(1);
    expect(master.functions![0].nodes[0].config).toMatchObject({ flowId: 'external-dependency' });
});

it('refuses incomplete Agent archives instead of silently losing their Flow dependency', async () => {
    const { runtime, resources } = await setup(); await runtime.agentService.saveAgent(agent());
    await expect(resources.export(['/agents' + runtime.agentService.getAgentResourceId('flow-agent')])).rejects.toThrow('dependency is missing');
    expect((await runtime.agentService.getAgentConfig('flow-agent'))?.execution).toMatchObject({ flowId: 'generic-flow' });
});

it.each([false, true])('plans all published dependencies before serializing selected drafts (childFirst=%s)', async childFirst => {
    const { runtime, resources } = await setup();
    const child = externalFlow('archive-child'), parent = externalFlow('archive-parent');
    parent.nodes = [{ id: 'call', name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId: child.id, parameters: {} } }] as FlowDraft['nodes'];
    parent.outputs = { result: { value: '${nodes.call.outputs.result}' } };
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [child, parent] });
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: child.id });
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft: { ...draft, name: 'UNPUBLISHED EDIT' }, expectedDraftVersion: draft.draftVersion });
    await runtime.agentService.saveAgent(agent({ kind: 'flow', flowId: parent.id }));
    const paths = ['/agents' + runtime.agentService.getAgentResourceId('flow-agent'), '/flows/archive-child.flow'];
    const archive = JSON.parse(await resources.export(childFirst ? paths.reverse() : paths));
    expect(archive.entries.find((entry: { data: FlowDraft }) => entry.data.id === child.id).data.name).toBe(child.name);
});

it('rejects incompatible published versions across the entire archive closure', async () => {
    const { runtime, resources } = await setup();
    await publish(runtime, externalFlow('archive-shared'));
    const wrapper = externalFlow('archive-wrapper');
    wrapper.nodes = [{ id: 'inner', name: 'Inner', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId: 'archive-shared' } }] as FlowDraft['nodes'];
    wrapper.outputs = { result: { value: '${nodes.inner.outputs.result}' } };
    await publish(runtime, wrapper);
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: 'archive-shared' });
    await runtime.commandBus.execute(FlowCommand.RevisionCreate, { draftId: draft.id, expectedDraftVersion: draft.draftVersion });
    const root = externalFlow('archive-root');
    root.nodes = ['archive-shared', 'archive-wrapper'].map((flowId, index) => ({ id: `call${index}`, name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId } })) as FlowDraft['nodes'];
    root.outputs = { result: { value: '${nodes.call0.outputs.result}' } };
    await publish(runtime, root); await runtime.agentService.saveAgent(agent({ kind: 'flow', flowId: root.id }));
    await expect(resources.export(['/agents' + runtime.agentService.getAgentResourceId('flow-agent')])).rejects.toThrow('conflicting Flow revisions');
});

import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { FlowCommand, type FlowRevision } from '@itookit/llm-flow/contracts';
import { SessionCommand, type SessionInstructionQueue } from '@itookit/llm-session/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../src/host/application-services';
import { createApplicationClient } from '../src/host/application-client';
import { FlowDefinitionStore } from '@itookit/llm-flow';
import { compileAgentComposition } from '../src/configuration/agent-composition';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
type Request = { model?: string; stream?: boolean; messages: Array<{ role: string; content: string }>; tools?: unknown[] };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const team = (): AgentDefinition => ({ id: 'team', name: 'Team', type: 'composite', config: {},
    composition: { coordinatorAgentId: 'host', memberAgentIds: ['a', 'b'], maxDelegations: 2, maxConcurrency: 2 } });

async function setup(illegal = false) {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', { id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture',
        baseURL: 'http://localhost:18449', models: [{ id: 'mock-model', name: 'Mock' }] });
    await write('/etc/llm/.connections/default.json', { id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: { optimal: 'mock-model' } });
    await write('/etc/llm/.connection-settings.json', { defaultConnectionId: 'default' });
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const request = JSON.parse(options.body) as Request; requests.push(request);
        const summary = request.messages.some(message => message.content.includes('Produce the final answer yourself'));
        const worker = request.messages.some(message => message.content.includes('MEMBER_A'));
        const message = summary ? { role: 'assistant', content: 'FINAL_A' } : worker ? { role: 'assistant', content: 'A_RESULT' }
            : { role: 'assistant', content: '', tool_calls: [{ id: 'choose-a', type: 'function', function: { name: 'delegate_tasks',
                arguments: JSON.stringify({ items: [{ agentId: illegal ? 'forbidden' : 'a', instruction: 'Complete the assigned part' }] }) } }] };
        return completion(request, message);
    }));
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false }); cleanup.push(() => runtime.dispose());
    for (const [id, prompt] of [['host', 'COORDINATOR'], ['a', 'MEMBER_A'], ['b', 'MEMBER_B']]) {
        await runtime.agentService.saveAgent({ id, name: id, type: 'agent', config: { systemPrompt: prompt }, capabilityPolicy: { toolIds: [], mcpProfileIds: [] } });
    }
    return { runtime, backend, requests };
}

function completion(request: Request, message: Record<string, unknown>) {
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    const choices = [{ index: 0, message, finish_reason: finish }];
    if (!request.stream) return new Response(JSON.stringify({ id: 'response', choices, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
    const delta = { ...message, ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call as object, index })) } : {}) };
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    return new Response(chunk({ id: 'response', choices: [{ index: 0, delta, finish_reason: null }] })
        + chunk({ id: 'response', choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

async function send(runtime: Runtime) {
    const id = await runtime.sessionRepository.createSession('Composite');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Original request', files: [], agentId: 'team',
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'team', mode: 'agent' } } });
    return id;
}

it('persists author configuration and a stable managed Flow binding, reusing unchanged revisions', async () => {
    const { runtime } = await setup(); await runtime.agentService.saveAgent(team());
    const first = (await runtime.agentService.getAgentConfig('team'))!;
    expect(first).toMatchObject({ composition: team().composition, execution: { kind: 'flow', revision: 1 }, availability: { status: 'ready' } });
    await runtime.agentService.saveAgent(first); expect((await runtime.agentService.getAgentConfig('team'))!.execution).toEqual(first.execution);
    await runtime.agentService.saveAgent({ ...first, composition: { ...first.composition!, maxDelegations: 3 } });
    expect((await runtime.agentService.getAgentConfig('team'))!.execution).toEqual({ ...first.execution, revision: 2 });
    const source = JSON.parse(await runtime.agentService.engine.driver.readContent(runtime.agentService.getAgentResourceId('team')!, { encoding: 'utf-8' }));
    expect(source.composition.memberAgentIds).toEqual(['a', 'b']); expect(source).not.toHaveProperty('availability');
});

it('serializes concurrent preparation and saves so the final author configuration matches its published revision', async () => {
    const { runtime } = await setup(); await runtime.agentService.saveAgent(team());
    const original = FlowDefinitionStore.prototype.createRevision;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const publish = vi.spyOn(FlowDefinitionStore.prototype, 'createRevision').mockImplementationOnce(async function (draft) {
        await gate; return original.call(this, draft);
    });
    const first = runtime.agentService.saveAgent({ ...team(), composition: { ...team().composition!, maxDelegations: 3 } });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const second = runtime.agentService.saveAgent({ ...team(), composition: { ...team().composition!, maxDelegations: 4 } });
    release(); await Promise.all([first, second]);
    const saved = (await runtime.agentService.getAgentConfig('team'))!;
    expect(saved.composition!.maxDelegations).toBe(4);
    expect(saved.execution).toMatchObject({ revision: 3 });
    const binding = saved.execution as { flowId: string; revision: number };
    const flow = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: binding.flowId, revision: binding.revision });
    expect((flow.nodes[0].config as any).delegation.fanout.maxTasks).toBe(4);
});

it('checks the complete published body before reusing a managed revision', async () => {
    const { runtime } = await setup(); await runtime.agentService.saveAgent(team());
    const binding = (await runtime.agentService.getAgentConfig('team'))!.execution as { flowId: string; revision: number };
    const draft = await runtime.commandBus.execute<import('@itookit/llm-flow/contracts').FlowDraft>(FlowCommand.DraftLoad, { id: binding.flowId });
    const edited = await runtime.commandBus.execute<{ draft: typeof draft }>(FlowCommand.DraftSave, {
        draft: { ...draft, systemPrompt: ['Unexpected global instruction'] }, expectedDraftVersion: draft.draftVersion,
    });
    await runtime.commandBus.execute(FlowCommand.RevisionCreate, { draftId: binding.flowId, expectedDraftVersion: edited.draft.draftVersion });
    await runtime.agentService.saveAgent(team());
    expect((await runtime.agentService.getAgentConfig('team'))!.execution).toMatchObject({ revision: 3 });
    const restored = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: binding.flowId });
    expect(restored.systemPrompt).toBeUndefined();
});

it('runs only the dynamically selected member and lets the coordinator summarize its result', async () => {
    const { runtime, requests } = await setup(); await runtime.agentService.saveAgent(team()); const id = await send(runtime);
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds.map(round => round.status)).toEqual(['completed']), { timeout: 10_000 });
    expect(requests).toHaveLength(3);
    expect(requests.some(request => request.messages.some(message => message.content.includes('MEMBER_B')))).toBe(false);
    const summary = requests.find(request => request.messages.some(message => message.content.includes('Produce the final answer yourself')))!;
    expect(JSON.stringify(summary.messages)).toContain('A_RESULT');
    expect(JSON.stringify(summary.messages)).toContain('Original request');
    const root = (await runtime.kernel.kernel.listSessionTasks(id)).find(task => task.labels?.kind === 'flow-root')!;
    expect(JSON.stringify(root.output)).toContain('FINAL_A');
}, 15_000);

it('rejects an unauthorized member returned by the model before running any child or summary', async () => {
    const { runtime, requests } = await setup(true); await runtime.agentService.saveAgent(team()); const id = await send(runtime);
    await vi.waitFor(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        expect(rounds[0]?.status).toBe('failed');
    }, { timeout: 10_000 });
    expect(requests).toHaveLength(1);
    expect((await runtime.kernel.kernel.listSessionTasks(id)).filter(task => String(task.requestId).includes(':delegate:'))).toHaveLength(0);
}, 15_000);

it('freezes candidate identities before queue acceptance and keeps them after source deletion', async () => {
    const { runtime, requests } = await setup(); await runtime.agentService.saveAgent(team());
    const id = await runtime.sessionRepository.createSession('Queued composite'); await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    const session = await runtime.kernel.kernel.openSession(id); await session.suspend();
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Original request', files: [], agentId: 'team' });
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(queue.items[0].flowBinding?.plan?.identities.agents.map(([id]) => id)).toContain('a');
    await runtime.agentService.deleteAgent('a'); await session.resume();
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds[0]?.status).toBe('completed'), { timeout: 10_000 });
    expect(requests).toHaveLength(3);
}, 15_000);

it('blocks invalid compositions without overwriting the saved author configuration', async () => {
    const { runtime } = await setup(); await runtime.agentService.saveAgent(team());
    const original = (await runtime.agentService.getAgentConfig('team'))!;
    await expect(runtime.agentService.saveAgent({ ...team(), composition: { coordinatorAgentId: 'team', memberAgentIds: ['a'] } })).rejects.toThrow('itself');
    await expect(runtime.agentService.saveAgent({ ...team(), composition: { coordinatorAgentId: 'host', memberAgentIds: ['host'] } })).rejects.toThrow('separate');
    expect((await runtime.agentService.getAgentConfig('team'))!.execution).toEqual(original.execution);
    const binding = original.execution as { flowId: string; revision: number };
    const published = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: binding.flowId, revision: binding.revision });
    expect(published.nodes).toHaveLength(2);
});

it('reserves persistent Flow ownership before publication and reuses it after Agent write failure and restart', async () => {
    const { runtime, backend } = await setup();
    const create = runtime.agentService.engine.driver.createFile.bind(runtime.agentService.engine.driver);
    const failure = vi.spyOn(runtime.agentService.engine.driver, 'createFile').mockImplementation(async options => {
        if (options.name === 'team.agent') throw new Error('Injected Agent write failure');
        return create(options);
    });
    await expect(runtime.agentService.saveAgent(team())).rejects.toThrow('Injected');
    expect(await runtime.agentService.getAgentConfig('team')).toBeNull();
    const receiptFile = (await runtime.flowEngine.findFile('.agent-composition-team.json'))!;
    const receipt = JSON.parse((await runtime.flowEngine.readFile(receiptFile.nodeId))!);
    expect(receipt).toMatchObject({ version: 1, agentId: 'team' });
    expect(await runtime.flowEngine.findFile(receipt.flowId + '.flow')).not.toBeNull(); failure.mockRestore();
    vi.spyOn(backend, 'close').mockResolvedValue(undefined); await runtime.dispose();
    const restored = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false }); cleanup.push(() => restored.dispose());
    await restored.agentService.saveAgent(team());
    expect((await restored.agentService.getAgentConfig('team'))!.execution).toEqual({ kind: 'flow', flowId: receipt.flowId, revision: 1 });
    expect((await restored.flowEngine.listFiles()).filter(file => file.name === receipt.flowId + '.flow')).toHaveLength(1);
});

it('does not overwrite an external Flow supplied in the Agent document and stops when ownership reservation fails', async () => {
    const { runtime } = await setup();
    const external = await runtime.commandBus.execute<{ id: string; draftVersion: number }>(FlowCommand.DraftCreate, { id: 'external', name: 'User Flow' });
    const userFlow = compileAgentComposition(team(), 'external', await runtime.agentService.getAgents()); userFlow.name = 'User Flow';
    (userFlow.nodes[0].config as any).instruction = 'Preserve this manually authored behavior';
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft: userFlow, expectedDraftVersion: external.draftVersion });
    const before = await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: 'external' });
    await runtime.agentService.engine.driver.createFile({ name: 'team.agent', parentPath: '/default', content: JSON.stringify({ ...team(), execution: { kind: 'flow', flowId: 'external' } }) });
    await vi.waitFor(async () => expect((await runtime.agentService.getAgentConfig('team'))?.execution).toMatchObject({ flowId: 'external' }));
    await runtime.agentService.saveAgent({ ...team(), execution: { kind: 'flow', flowId: external.id } });
    expect((await runtime.agentService.getAgentConfig('team'))!.execution).not.toMatchObject({ flowId: 'external' });
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: 'external' })).toEqual(before);
    const create = runtime.flowEngine.createFile.bind(runtime.flowEngine);
    vi.spyOn(runtime.flowEngine, 'createFile').mockImplementation((name, content) => name.startsWith('.agent-composition-other')
        ? Promise.reject(new Error('Receipt write failed')) : create(name, content));
    const count = (await runtime.flowEngine.listFiles()).length;
    await expect(runtime.agentService.saveAgent({ ...team(), id: 'other' })).rejects.toThrow('Receipt');
    expect((await runtime.flowEngine.listFiles()).length).toBe(count);
});

it('roundtrips Composite author configuration with coordinator and members remapped before managed recompilation', async () => {
    const { runtime } = await setup(); await runtime.agentService.saveAgent(team());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const resources = (await client.backend.toolboxView()).resources;
    const archive = await resources.export(['/agents' + runtime.agentService.getAgentResourceId('team')!]);
    const data = JSON.parse(archive);
    expect(data.entries.filter((entry: { kind: string }) => entry.kind === 'agents')).toHaveLength(4);
    expect(data.entries.some((entry: { kind: string }) => entry.kind === 'flows')).toBe(false);
    await resources.import(archive);
    const imported = (await runtime.agentService.getAgents()).find(agent => agent.id !== 'team' && agent.name === 'Team')!;
    expect(imported.composition!.coordinatorAgentId).not.toBe('host');
    expect(imported.composition!.memberAgentIds).not.toContain('a');
    expect(imported.composition!.memberAgentIds).not.toContain('b');
    expect((await runtime.agentService.getAgentConfig(imported.composition!.coordinatorAgentId))!.name).toBe('host');
    expect(imported).toMatchObject({ execution: { kind: 'flow', revision: 1 }, availability: { status: 'ready' } });
});

it.each(['unset', 'disabled'])('freezes candidate models without consulting an unrelated %s default', async systemDefault => {
    const { runtime, requests } = await setup();
    const provider = runtime.agentService.getProviders().find(provider => provider.id === 'mock')!;
    await runtime.agentService.saveProvider({ ...provider, models: [...provider.models,
        ...['model-a', 'model-b', 'model-changed'].map(id => ({ id, name: id }))] });
    for (const id of ['a', 'b']) {
        await runtime.agentService.saveConnection({ id: 'connection-' + id, name: id, providerId: 'mock', protocol: 'openai-chat', tiers: { optimal: 'model-' + id } });
        const agent = (await runtime.agentService.getAgentConfig(id))!;
        await runtime.agentService.saveAgent({ ...agent, modelDefaults: { chat: 'connection-' + id } });
    }
    const host = (await runtime.agentService.getAgentConfig('host'))!;
    await runtime.agentService.saveConnection({ id: 'host-choice', name: 'Host', providerId: 'mock', protocol: 'openai-chat', tiers: { optimal: 'mock-model' } });
    await runtime.agentService.saveAgent({ ...host, modelDefaults: { chat: 'host-choice' } });
    if (systemDefault === 'unset') await runtime.agentService.setDefaultConnection(null);
    else {
        const fallback = (await runtime.agentService.getConnections()).find(connection => connection.id === 'default')!;
        await runtime.agentService.saveConnection({ ...fallback, enabled: false });
    }
    await runtime.agentService.saveAgent(team());
    const published = (await runtime.agentService.getAgentConfig('team'))!.execution as { flowId: string; revision: number };
    await expect(runtime.commandBus.execute(SessionCommand.CheckFlowConnections, { flowId: published.flowId, revision: published.revision, agentId: 'team' })).resolves.toEqual({ valid: true });
    const id = await runtime.sessionRepository.createSession('Frozen member models'); await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    const session = await runtime.kernel.kernel.openSession(id); await session.suspend();
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Original request', files: [], agentId: 'team' });
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    const connections = queue.items[0].flowBinding!.connections.connections;
    expect(connections.find(connection => connection.id === 'connection-a')!.tiers!.optimal).toBe('model-a');
    expect(connections.find(connection => connection.id === 'connection-b')!.tiers!.optimal).toBe('model-b');
    const connection = (await runtime.agentService.getConnections()).find(connection => connection.id === 'connection-a')!;
    await runtime.agentService.saveConnection({ ...connection, tiers: { optimal: 'model-changed' } });
    await session.resume();
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds[0]?.status).toBe('completed'), { timeout: 10_000 });
    expect(requests.find(request => request.messages.some(message => message.content.includes('MEMBER_A')))!.model).toBe('model-a');
}, 15_000);

it('rejects a changed candidate endpoint before executing any part of an accepted composition', async () => {
    const { runtime, requests } = await setup();
    const connection = { id: 'member-choice', name: 'Member', providerId: 'mock', protocol: 'openai-chat' as const,
        baseURL: 'http://localhost:18449', tiers: { optimal: 'mock-model' } };
    await runtime.agentService.saveConnection(connection);
    const member = (await runtime.agentService.getAgentConfig('a'))!;
    await runtime.agentService.saveAgent({ ...member, modelDefaults: { chat: connection.id } });
    await runtime.agentService.saveAgent(team());
    const id = await runtime.sessionRepository.createSession('Changed endpoint');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    const session = await runtime.kernel.kernel.openSession(id); await session.suspend();
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Original request', files: [], agentId: 'team' });
    await runtime.agentService.saveConnection({ ...connection, baseURL: 'http://localhost:18450' });
    await session.resume();
    await vi.waitFor(async () => {
        const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        expect(queue.items.find(item => item.state === 'failed')?.error).toMatch(/connection changed after admission: member-choice/i);
    }, { timeout: 10_000 });
    expect((await runtime.sessionRepository.readHistoryChain(id)).rounds).toHaveLength(0);
    expect(requests).toHaveLength(0);
}, 15_000);

it('retries publication instead of binding a previous revision after a publish failure', async () => {
    const { runtime } = await setup();
    await runtime.agentService.saveAgent(team());
    const next = { ...team(), composition: { ...team().composition!, maxDelegations: 3 } };
    const publish = vi.spyOn(FlowDefinitionStore.prototype, 'createRevision').mockRejectedValueOnce(new Error('Injected publish failure'));
    await expect(runtime.agentService.saveAgent(next)).rejects.toThrow('Injected');
    await runtime.agentService.saveAgent(next);
    expect((await runtime.agentService.getAgentConfig('team'))!.execution).toMatchObject({ revision: 2 });
    publish.mockRestore();
});

it('remaps Agent purpose defaults to the imported connection', async () => {
    const { runtime } = await setup();
    const host = (await runtime.agentService.getAgentConfig('host'))!;
    await runtime.agentService.saveAgent({ ...host, modelDefaults: { chat: 'default' } });
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const resources = (await client.backend.toolboxView()).resources;
    const archive = await resources.export(['/agents' + runtime.agentService.getAgentResourceId('host')!, '/connections/default', '/providers/mock']);
    await resources.import(archive);
    const imported = (await runtime.agentService.getAgents()).find(agent => agent.id !== 'host' && agent.name === 'host')!;
    expect(imported.modelDefaults!.chat).not.toBe('default');
});

it.each(['run', 'session'])('freezes the explicit %s connection for every delegated member', async source => {
    const { runtime, requests } = await setup();
    const provider = runtime.agentService.getProviders().find(provider => provider.id === 'mock')!;
    await runtime.agentService.saveProvider({ ...provider, models: [...provider.models, { id: 'run-model', name: 'Run' }, { id: 'member-model', name: 'Member' }] });
    for (const [id, model] of [['run-choice', 'run-model'], ['member-choice', 'member-model']]) {
        await runtime.agentService.saveConnection({ id, name: id, providerId: 'mock', protocol: 'openai-chat', tiers: { optimal: model } });
    }
    const member = (await runtime.agentService.getAgentConfig('a'))!;
    await runtime.agentService.saveAgent({ ...member, modelDefaults: { chat: 'member-choice' } });
    await runtime.agentService.saveAgent(team());
    const id = await runtime.sessionRepository.createSession('Explicit connection');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    if (source === 'session') await runtime.sessionRepository.saveSessionSettings(id, { connectionId: 'run-choice' });
    const session = await runtime.kernel.kernel.openSession(id); await session.suspend();
    const binding = (await runtime.agentService.getAgentConfig('team'))!.execution as { flowId: string; revision: number };
    await expect(runtime.commandBus.execute(SessionCommand.CheckFlowConnections, { ...binding, agentId: 'team', connectionId: 'run-choice' })).resolves.toEqual({ valid: true });
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Original request', files: [], agentId: 'team',
        ...(source === 'run' ? { overrides: { connectionId: 'run-choice' } } : {}) });
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    const config = queue.items[0].flowBinding!.plan!.graph.nodes.find(node => node.id === 'coordinator')!.config as any;
    expect(config.delegation.resolvedTemplates.a.config).toMatchObject({ connectionId: 'run-choice', modelName: 'run-model' });
    expect(JSON.stringify(config.delegation.resolvedTemplates)).not.toContain('MEMBER_A');
    const connection = (await runtime.agentService.getConnections()).find(connection => connection.id === 'run-choice')!;
    await runtime.agentService.saveConnection({ ...connection, tiers: { optimal: 'member-model' } });
    await runtime.agentService.setDefaultConnection('member-choice');
    await session.resume();
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds[0]?.status).toBe('completed'), { timeout: 10_000 });
    expect(requests.map(request => request.model)).toEqual(['run-model', 'run-model', 'run-model']);
}, 15_000);

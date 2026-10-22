import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { getLogger } from '@itookit/common';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import { SessionCommand, type SessionInstructionQueue } from '@itookit/llm-session/contracts';
import { readSessionInstructionQueue } from '@itookit/llm-session';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
type Request = { model: string; stream?: boolean; messages: Array<{ role: string; content: unknown }> };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

async function storage() {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    const models = [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }];
    for (const id of ['mock', 'other']) await write(`/etc/llm/.providers/${id}.json`, { id, name: id,
        implementation: 'openai-compatible', apiKey: 'fixture-key', baseURL: 'http://localhost:18449', models });
    await write('/etc/llm/.connections/default.json', { id: 'default', name: 'Default', providerId: 'mock',
        protocol: 'openai-chat', tiers: { optimal: 'model-a', standard: 'model-a' } });
    await write('/etc/llm/.connection-settings.json', { defaultConnectionId: 'default' });
    return backend;
}

function model() {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const request = JSON.parse(options.body) as Request; requests.push(request);
        const completion = { id: 'completion', object: 'chat.completion', created: 1, model: request.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
        return new Response(JSON.stringify(completion), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return requests;
}

function worker(id = 'chat-worker'): FlowDraft {
    return { id, name: 'Chat worker', draftVersion: 1, updatedAt: 0,
        connections: [{ name: 'text', required: true, tier: 'standard', requirements: { operation: 'chat' } }],
        nodes: [{ id: 'answer', name: 'Answer', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { connectionSlot: 'text', instruction: 'Return done.', stream: false, approval: 'none', toolIds: [], skillIds: [] } }],
        edges: [], outputs: { result: { value: '${nodes.answer.outputs.result}' } } } as FlowDraft;
}

function invocation(mode: 'direct' | 'nested' | 'batch') {
    const child = worker('nested-worker');
    if (mode === 'direct') return { definition: worker(), dependencies: [], requestCount: 1 };
    const definition = worker();
    definition.nodes = [{ id: 'call', name: 'Call worker', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
        config: { flowId: child.id, connectionBindings: { text: 'text' }, ...(mode === 'batch' ? { parameterSets: [{}, {}], maxConcurrency: 1 } : {}) } }];
    definition.outputs = { result: { value: '${nodes.call.outputs.result}' } };
    return { definition, dependencies: [child], requestCount: mode === 'batch' ? 2 : 1 };
}

async function setup(definition = worker(), dependencies: FlowDraft[] = [], configure?: (runtime: Runtime) => Promise<void>) {
    const requests = model();
    const backend = await storage();
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [...dependencies, definition] });
    await runtime.agentService.saveAgent({ id: 'flow-agent', name: 'Flow Agent', type: 'workflow', config: {},
        execution: { kind: 'flow', flowId: definition.id, connectionBindings: { text: 'default' } } });
    await configure?.(runtime);
    const id = await runtime.sessionRepository.createSession('Frozen Flow connection');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    const session = await runtime.kernel.kernel.openSession(id); await session.suspend();
    const instructionId = await runtime.commandBus.execute<string>(SessionCommand.Send, { text: 'accepted request', files: [], agentId: 'flow-agent',
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'flow-agent', mode: 'agent' } } });
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(queue.items).toMatchObject([{ id: instructionId, state: 'pending', flowBinding: { definition: { id: definition.id } } }]);
    expect(requests).toEqual([]);
    return { runtime, id, session, requests, backend };
}

async function changeConnection(runtime: Runtime, values: object) {
    const connection = (await runtime.agentService.getConnections()).find(value => value.id === 'default')!;
    await runtime.agentService.saveConnection({ ...connection, ...values });
}

async function completed(runtime: Runtime, id: string, errors: string[] = []) {
    await vi.waitFor(async () => {
        expect(errors).toEqual([]);
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        const queue = await readSessionInstructionQueue(runtime.kernel.kernel, id);
        expect(rounds, JSON.stringify({ paused: queue.paused, items: queue.items.map(item => ({ state: item.state, error: item.error })),
            activity: await runtime.kernel.kernel.sessionActivity(id) })).toHaveLength(1); expect(rounds[0].status).toBe('completed');
    }, { timeout: 10_000 });
}

it.each(['direct', 'nested', 'batch'] as const)('keeps the admitted chat model when the same connection tiers change before dispatch (%s)', async mode => {
    const { definition, dependencies, requestCount } = invocation(mode);
    const { runtime, id, session, requests } = await setup(definition, dependencies);
    await changeConnection(runtime, { tiers: { optimal: 'model-b', standard: 'model-b' } });
    await session.resume(); await completed(runtime, id);
    expect(requests.map(value => value.model)).toEqual(Array(requestCount).fill('model-a'));
}, 15_000);

it.each([{ providerId: 'other' }, { protocol: 'openai-responses' }])('rejects a changed connection identity after admission with no requests (%j)', async changed => {
    const { runtime, id, session, requests } = await setup();
    await changeConnection(runtime, changed); await session.resume();
    await vi.waitFor(async () => {
        const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        const error = queue.items.find(item => item.state === 'failed')?.error ?? rounds.find(round => round.status === 'failed')?.error;
        expect(error ?? '', JSON.stringify({ paused: queue.paused, items: queue.items.map(item => ({ state: item.state, error: item.error })),
            rounds: rounds.map(round => ({ status: round.status, error: round.error })), requests: requests.map(request => request.model),
            tasks: (await runtime.kernel.kernel.listSessionTasks(id)).map(task => ({ status: task.status, error: task.error })) })).toMatch(/connection changed after admission/i);
    }, { timeout: 10_000 });
    expect(requests).toEqual([]);
}, 15_000);


async function installIdentitySources(runtime: Runtime) {
    await runtime.agentService.saveAgent({ id: 'node-agent', name: 'Node Agent', type: 'agent', config: {}, systemPrompt: 'AGENT-ORIGINAL' });
    await runtime.agentService.saveSystemPrompt({ id: 'node-prompt', name: 'Prompt', content: ['PROMPT-ORIGINAL'] });
    await runtime.agentService.saveSkill({ id: 'node-skill', name: 'Skill', description: '', type: 'prompt', instructions: 'SKILL-ORIGINAL',
        enabled: true, tools: [], triggerPatterns: [], autoLoad: false, priority: 50, createdAt: 0, modifiedAt: 0 });
}

async function frozenIdentityRun(restart: boolean, revokeSkill: boolean) {
    const definition = worker();
    Object.assign(definition.nodes[0].config as object, { agentId: 'node-agent', systemPromptId: 'node-prompt', skillIds: ['node-skill'] });
    let { runtime, id, session, requests, backend } = await setup(definition, [], installIdentitySources);
    const queue = await readSessionInstructionQueue(runtime.kernel.kernel, id);
    expect(queue.items[0].flowBinding?.plan?.graph.nodes.length).toBeGreaterThan(0);
    if (restart) await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, { action: 'pause', expectedRevision: queue.revision });
    await runtime.agentService.deleteAgent('node-agent'); await runtime.agentService.deleteSystemPrompt('node-prompt');
    if (revokeSkill) await runtime.agentService.deleteSkill('node-skill');
    await runtime.flowEngine.deleteFile((await runtime.flowEngine.findFile('chat-worker.flow'))!.nodeId);
    if (restart) {
        vi.spyOn(backend, 'close').mockResolvedValue(undefined); await runtime.dispose();
        runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
        cleanup.push(() => runtime.dispose()); session = await runtime.kernel.kernel.openSession(id);
    }
    const observation = await runtime.openConversation(id); cleanup.push(() => observation.dispose());
    const errors: string[] = [];
    observation.sessionManager.onEvent(event => { if (event.type === 'error') errors.push(event.payload.error.message); });
    const reads = [vi.spyOn(runtime.flowEngine, 'readAsset'), vi.spyOn(runtime.agentService, 'getAgentConfig'),
        vi.spyOn(runtime.agentService, 'getSystemPrompt'), vi.spyOn(runtime.agentService, 'getSkills')];
    await session.resume();
    if (restart) await observation.commandBus.execute(SessionCommand.EditInstructionQueue, { action: 'resume',
        expectedRevision: (await readSessionInstructionQueue(runtime.kernel.kernel, id)).revision });
    return { runtime, id, requests, queue, errors, reads };
}

it.each([{ restart: false, revokeSkill: false }, { restart: true, revokeSkill: false }, { restart: true, revokeSkill: true }])(
    'preserves frozen definitions and current Skill authorization (%j)', async ({ restart, revokeSkill }) => {
    const { runtime, id, requests, queue, errors, reads } = await frozenIdentityRun(restart, revokeSkill);
    if (revokeSkill) {
        await vi.waitFor(() => expect(errors).toContain('Skill not found: node-skill'));
        expect(requests).toEqual([]); expect(await runtime.kernel.kernel.listSessionTasks(id)).toEqual([]);
        const logs = getLogger().query().filter(entry => entry.message === 'Session run failed'
            && (entry.data as { operationId?: string })?.operationId === queue.items[0].id);
        expect(logs).toHaveLength(1);
        expect(logs[0].data).toMatchObject({ stage: 'run-prepare-execute', errorCode: 'SKILL_UNAVAILABLE' });
        expect(JSON.stringify(logs)).not.toMatch(/ORIGINAL|fixture-key|accepted request/);
        return;
    }
    await completed(runtime, id, errors);
    const messages = JSON.stringify(requests[0].messages);
    for (const marker of ['AGENT-ORIGINAL', 'PROMPT-ORIGINAL', 'SKILL-ORIGINAL', 'accepted request']) expect(messages).toContain(marker);
    for (const read of reads) expect(read).not.toHaveBeenCalled();
}, 15_000);

it('assembles queued conversation history at dispatch rather than freezing an empty history at admission', async () => {
    const { runtime, id, session, requests } = await setup();
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'second queued request', files: [], agentId: 'flow-agent',
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'flow-agent', mode: 'agent' } } });
    await session.resume();
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds.map(round => round.status))
        .toEqual(['completed', 'completed']), { timeout: 10_000 });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'accepted request' }),
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('done') }),
        expect.objectContaining({ role: 'user', content: 'second queued request' }),
    ]));
}, 15_000);

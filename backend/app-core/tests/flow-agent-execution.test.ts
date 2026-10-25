import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft, type JsonValue } from '@itookit/llm-flow/contracts';
import { ContentTransferCommand, FlowInvocationCommand, SessionCommand, type FlowInvocationRecord, type SessionInstructionQueue } from '@itookit/llm-session/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

function flow(id = 'content-worker', marker = 'first'): FlowDraft {
    return { id, name: 'Content worker', draftVersion: 1, updatedAt: 0,
        parameters: [{ name: 'language', type: 'string', default: 'en' }, { name: 'count', type: 'number', integer: true, minimum: 1, default: 1 }],
        variables: { prompt: { type: 'string', initial: '${input.prompt}' } },
        nodes: [{ id: 'record', name: 'Return input', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: { value: { prompt: '${vars.prompt}', directPrompt: '${input.prompt}', language: '${param.language}', count: '${param.count}', marker } } }],
        edges: [], outputs: { result: { value: '${nodes.record.outputs.result}' } } } as FlowDraft;
}

async function setup(definition = flow(), dependencies: FlowDraft[] = []) {
    const backend = new MemoryBackend();
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [...dependencies, definition] });
    await runtime.agentService.saveAgent({ id: 'flow-agent', name: 'Content Agent', type: 'workflow', config: {},
        execution: { kind: 'flow', flowId: definition.id, parameters: { language: 'zh-CN' } } });
    const id = await runtime.sessionRepository.createSession('Flow Agent');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    return { runtime, id, backend };
}

function send(runtime: Runtime, text: string, parameters?: Record<string, JsonValue>) {
    return runtime.commandBus.execute<string>(SessionCommand.Send, { text, files: [], agentId: 'flow-agent',
        overrides: { executionMode: 'agent', flowParameters: parameters },
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'flow-agent', mode: 'agent' } } });
}

async function results(runtime: Runtime, id: string, count = 1) {
    await vi.waitFor(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        expect(rounds).toHaveLength(count);
        expect(rounds.map(round => round.status)).toEqual(Array(count).fill('completed'));
    }, { timeout: 10_000 });
    return (await runtime.kernel.kernel.listSessionTasks(id)).filter(task => task.labels?.kind === 'flow-root')
        .sort((a, b) => a.createdAt - b.createdAt).map(task => (task.output as any).nodes.__flow_return.outputs.result.content);
}

async function publish(runtime: Runtime, marker: string) {
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: 'content-worker' });
    (draft.nodes[0].config as any).value.marker = marker;
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft, expectedDraftVersion: draft.draftVersion });
    const saved = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: draft.id });
    return runtime.commandBus.execute(FlowCommand.RevisionCreate, { draftId: draft.id, expectedDraftVersion: saved.draftVersion });
}

it('runs an internal Flow Agent without a model and keeps prompt separate from runtime parameters', async () => {
    const fetch = vi.fn(() => { throw new Error('Deterministic Flow must not call a model'); }); vi.stubGlobal('fetch', fetch);
    const { runtime, id } = await setup();
    await send(runtime, 'Keep ${param.secret} as literal data', { count: 3 });
    expect(await results(runtime, id)).toEqual([{ prompt: 'Keep ${param.secret} as literal data', directPrompt: 'Keep ${param.secret} as literal data',
        language: 'zh-CN', count: 3, marker: 'first' }]);
    expect(fetch).not.toHaveBeenCalled();
    const round = (await runtime.sessionRepository.readHistoryChain(id)).rounds[0];
    expect(round.flow).toMatchObject({ flowId: 'content-worker', revision: 1, input: { prompt: 'Keep ${param.secret} as literal data' }, parameters: { language: 'zh-CN', count: 3 } });
    expect((await runtime.sessionRepository.getSessionSettings(id)).executionModeLocked).not.toBe(true);
}, 15_000);

it('executes a parameter-only Flow through the real Session queue and preserves its frozen input in history', async () => {
    const fetch = vi.fn(() => {throw new Error('Parameter-only deterministic Flow must not call a model');}); vi.stubGlobal('fetch', fetch);
    const {runtime, id} = await setup();
    await send(runtime, '', {count: 2});
    expect(await results(runtime, id)).toEqual([{prompt: '', directPrompt: '', language: 'zh-CN', count: 2, marker: 'first'}]);
    const round = (await runtime.sessionRepository.readHistoryChain(id)).rounds[0];
    expect(round.flow).toMatchObject({input: {prompt: ''}, parameters: {language: 'zh-CN', count: 2}});
    expect((await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const root = (await runtime.kernel.kernel.listSessionTasks(id)).find(task => task.labels?.kind === 'flow-root')!;
    expect(round.executions[0].invocation?.invocationId).toBeTruthy();
    expect(root.labels?.invocationId).toBe(round.executions[0].invocation?.invocationId);
    expect(root.input).toMatchObject({initialScheduler: {spec: {invocation: {invocationId: root.labels!.invocationId}}}});
});

it('preserves the claimed Flow Invocation across completion and creates linked identities on regeneration', async () => {
    const {runtime, id} = await setup();
    const claims: string[] = [];
    const release = runtime.sessionManager.onEvent(event => {
        if (event.type === 'instructions:changed') for (const item of event.payload.items)
            if (item.state === 'dispatching' && item.invocation && !claims.includes(item.invocation.invocationId)) claims.push(item.invocation.invocationId);
    });
    try {
        await send(runtime, 'Original Flow input'); await results(runtime, id);
        const original = (await runtime.sessionRepository.readHistoryChain(id)).rounds[0], reference = original.executions[0];
        expect(claims).toHaveLength(1); expect(reference.invocation?.invocationId).toBe(claims[0]);
        await vi.waitFor(() => expect(runtime.sessionManager.isGenerating()).toBe(false));
        const oldTask = (await (await runtime.kernel.kernel.openTask(reference.taskId)).status()).task;
        await runtime.sessionManager.regenerateFromUser(`round-${original.id}-user`);
        await vi.waitFor(async () => {
            const chain = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
            expect(chain.at(-1)?.status).toBe('completed'); expect(chain.at(-1)?.id).not.toBe(original.id);
        });
        const next = (await runtime.sessionRepository.readHistoryChain(id)).rounds.at(-1)!;
        expect(next.executions[0].invocation).toMatchObject({retryOfInvocationId: reference.invocation!.invocationId, retryOfSessionId: id});
        expect(next.executions[0].invocation!.invocationId).not.toBe(reference.invocation!.invocationId);
        expect((await (await runtime.kernel.kernel.openTask(reference.taskId)).status()).task).toEqual(oldTask);
        const groups = runtime.sessionManager.getSessions().filter(group => group.persistedNodeId === next.id);
        expect(groups.length).toBeGreaterThan(0);
        expect(groups.every(group => group.invocation?.invocationId === next.executions[0].invocation!.invocationId)).toBe(true);
    } finally {release();}
});

it('creates a linked child-Session invocation through the real host parent relationship', async () => {
    const definition = flow(); delete definition.variables;
    definition.nodes[0].config = {value: {language: '${param.language}', count: '${param.count}'}};
    const {runtime, id} = await setup(definition);
    const original = await runtime.commandBus.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, {
        sessionId: id, requestId: 'parent-call', flowId: definition.id, revision: 1, parameters: {count: 2}});
    expect((await (await runtime.kernel.kernel.openTask(original.rootTaskId!)).wait({timeoutMs: 3000})).status).toBe('succeeded');
    const child = await runtime.commandBus.execute<{sessionId: string}>(ContentTransferCommand.CreateChild,
        {sessionId: id, requestId: 'new-child', title: 'Independent child call'});
    const next = await runtime.commandBus.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, {
        sessionId: child.sessionId, requestId: 'child-call', flowId: definition.id, revision: 1, parameters: {count: 3},
        retryOfInvocationId: original.invocationId, retryOfSessionId: id});
    expect(next.invocationId).not.toBe(original.invocationId);
    expect(next).toMatchObject({retryOfInvocationId: original.invocationId, retryOfSessionId: id});
    expect(next.rootTaskId).not.toBe(original.rootTaskId);
    expect((await runtime.sessionRepository.getManifest(child.sessionId)).parentSessionId).toBe(id);
    expect((await (await runtime.kernel.kernel.openTask(next.rootTaskId!)).wait({timeoutMs: 3000})).status).toBe('succeeded');
    expect((await (await runtime.kernel.kernel.openTask(original.rootTaskId!)).status()).task.status).toBe('succeeded');
});

it('passes upstream structured data through a transform when the Session binder also injects its prompt', async () => {
    const value = {cards: [{name: 'apple', unit: 2}], groups: [[{name: 'apple', unit: 2}]]};
    const definition = flow(); delete definition.variables;
    definition.nodes = [
        {id: 'prepare' as never, name: 'Prepared data', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value}},
        {id: 'normalize' as never, name: 'Normalize', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {}},
        {id: 'consume' as never, name: 'Read structured cards', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: {value: '${nodes.normalize.outputs.result.cards}'}},
    ];
    definition.edges = [{id: 'prepare-normalize' as never, from: 'prepare' as never, to: 'normalize' as never,
        kind: 'data', input: 'input', output: 'result'}];
    definition.outputs = {result: {value: '${nodes.consume.outputs.result}'}};
    const {runtime, id} = await setup(definition);
    await send(runtime, 'Global request separate from prepared cards');
    expect(await results(runtime, id)).toEqual([value.cards]);
    const task = (await runtime.kernel.kernel.listSessionTasks(id)).find(task => (task.input as any)?.nodeId === 'normalize')!;
    expect(task.input).toMatchObject({inputs: {prompt: 'Global request separate from prepared cards'}});
    expect(task.output).toMatchObject({outputs: {result: {content: value}}});
});

it('follows new published configuration on subsequent calls and supports a pinned version', async () => {
    const { runtime, id } = await setup();
    await send(runtime, 'first request'); expect((await results(runtime, id))[0].marker).toBe('first');
    await publish(runtime, 'second');
    await send(runtime, 'second request'); expect((await results(runtime, id, 2)).map(row => row.marker)).toEqual(['first', 'second']);
    const agent = (await runtime.agentService.getAgentConfig('flow-agent'))!;
    await runtime.agentService.saveAgent({ ...agent, execution: { ...agent.execution!, kind: 'flow', flowId: 'content-worker', revision: 1 } });
    await send(runtime, 'pinned request'); expect((await results(runtime, id, 3)).map(row => row.marker)).toEqual(['first', 'second', 'first']);
});

it('does not require an unrelated disabled default model connection for a deterministic Flow', async () => {
    const { runtime, id } = await setup();
    vi.spyOn(runtime.agentService, 'getModelDefaults').mockResolvedValue({ chat: 'disabled-chat' });
    const connection = vi.spyOn(runtime.agentService, 'getConnection').mockResolvedValue({ id: 'disabled-chat', name: 'Disabled', providerId: 'missing', enabled: false } as never);
    await send(runtime, 'deterministic request');
    expect((await results(runtime, id))[0].prompt).toBe('deterministic request');
    expect(connection).not.toHaveBeenCalled();
});

it('blocks deleted Flow bindings before accepting new work and becomes available after restoration', async () => {
    const { runtime, id } = await setup();
    const source = (await runtime.flowEngine.findFile('content-worker.flow'))!;
    await runtime.flowEngine.deleteFile(source.nodeId);
    await expect(send(runtime, 'cannot run deleted Flow')).rejects.toThrow(/Flow|flow/);
    expect((await runtime.kernel.kernel.listSessionTasks(id)).filter(task => task.labels?.kind === 'flow-root')).toEqual([]);
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [flow()] });
    await send(runtime, 'restored'); expect((await results(runtime, id))[0].prompt).toBe('restored');
});

it('freezes accepted queued calls before a Flow update or deletion, including their parameter values', async () => {
    const { runtime, id } = await setup();
    await (await runtime.kernel.kernel.openSession(id)).suspend();
    await send(runtime, 'queued ${param.literal}', { count: 2 });
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(queue.items[0].flowBinding?.definition.revision).toBe(1);
    expect(queue.items[0].sendIntent?.execution).toMatchObject({ kind: 'flow', parameters: { language: 'zh-CN', count: 2 } });
    await publish(runtime, 'changed after acceptance');
    await runtime.flowEngine.deleteFile((await runtime.flowEngine.findFile('content-worker.flow'))!.nodeId);
    await (await runtime.kernel.kernel.openSession(id)).resume();
    expect(await results(runtime, id)).toEqual([{ prompt: 'queued ${param.literal}', directPrompt: 'queued ${param.literal}', language: 'zh-CN', count: 2, marker: 'first' }]);
});

it.each([{ count: 0 }, { unknown: 'value' }, { language: 123 }])('rejects invalid runtime parameters before queue acceptance (%j)', async parameters => {
    const { runtime, id } = await setup();
    await expect(send(runtime, 'invalid', parameters)).rejects.toThrow(/parameter|Parameter/);
    expect((await runtime.kernel.kernel.listSessionTasks(id)).filter(task => task.labels?.kind === 'flow-root')).toEqual([]);
    expect((await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toEqual([]);
});

it('recovers accepted Agent calls and their external Flow dependencies after host restart and source deletion', async () => {
    const outer = flow('outer-worker');
    outer.nodes = [{ id: 'call', name: 'Call registered worker', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
        config: { flowId: 'external-worker', parameters: { language: '${param.language}', count: '${param.count}' } } }];
    outer.outputs = { result: { value: '${nodes.call.outputs.result}' } };
    const { runtime, id, backend } = await setup(outer, [flow('external-worker')]);
    const close = vi.spyOn(backend, 'close').mockResolvedValue(undefined);
    try {
        await (await runtime.kernel.kernel.openSession(id)).suspend();
        await send(runtime, 'durable ${param.literal}', { count: 4 });
        const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        expect(queue.items[0].flowBinding?.dependencies.map(value => value.id)).toEqual(['external-worker']);
        for (const name of ['outer-worker', 'external-worker']) await runtime.flowEngine.deleteFile((await runtime.flowEngine.findFile(`${name}.flow`))!.nodeId);
        await runtime.dispose();
        const restored = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
        cleanup.push(() => restored.dispose());
        await (await restored.kernel.kernel.openSession(id)).resume();
        expect(await results(restored, id)).toEqual([{ prompt: 'durable ${param.literal}', directPrompt: 'durable ${param.literal}', language: 'zh-CN', count: 4, marker: 'first' }]);
    } finally { close.mockRestore(); }
}, 15_000);

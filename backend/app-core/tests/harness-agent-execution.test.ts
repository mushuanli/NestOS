import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import type { HarnessClient } from '@itookit/mindos-node-driver';
import type { HarnessConnectionSnapshot } from '@itookit/kernel-adapters/contracts';
import { SessionCommand, type ContextBindingPage } from '@itookit/llm-session/contracts';
import { FlowLibraryCommand, InputAssetCommand } from '@itookit/app-contracts';
import {createTaskAssetStore} from '../src/runtime/task-asset-store';
import {buildTool, TaskListTool} from '@itookit/tools';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import {CONTEXT_BINDINGS_KEY} from '../src/projects/harness-context-bindings';
import {harnessExecutionJournalKey} from '../src/projects/harness-execution-journal';
import {sha256Hex} from '@itookit/llm-context/digest';

const connection: HarnessConnectionSnapshot = { id: 'remote', name: 'Remote', kind: 'harness', nodeConnectionId: 'node',
    projectId: 'project', profileId: 'claude', version: 1, revision: 1, project: { serverProjectId: 'native-project' } };
type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const runtimes: Runtime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(checkpointFork = false, attachmentKinds?: Array<'text' | 'image'>, turnGate?: () => Promise<void>,
    additionalTools?: NonNullable<NonNullable<Parameters<typeof createApplicationRuntime>[0]>['kernelPlatform']>['additionalTools']) {
    const fetch = vi.fn(async () => { throw new Error('A remote Agent must not use a local model'); }); vi.stubGlobal('fetch', fetch);
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false, kernelPlatform: {additionalTools} });
    runtimes.push(runtime);
    const prompts: string[] = [], sessions: string[] = [], attachments: unknown[][] = [];
    const forks: Array<{source: string; checkpoint?: string}> = [];
    vi.spyOn(runtime.executionConnections, 'freeze').mockResolvedValue(connection);
    vi.spyOn(runtime.executionConnections, 'validate').mockResolvedValue();
    vi.spyOn(runtime.executionConnections, 'acquire').mockImplementation(async () => {
        let id = '', turn = '';
        const client = { create: async () => { id = `native-${sessions.length}`; sessions.push(id); return { session: { id } }; },
            ...(checkpointFork ? {fork: async (_profile: string, source: string, _name: string | undefined, options: {lastTurnId?: string}) => {
                forks.push({source, checkpoint: options.lastTurnId}); id = `native-${sessions.length}`; sessions.push(id);
                return {session: {id}, checkpoint: {sourceSessionId: source, turnId: options.lastTurnId, verified: true}};
            }} : {}),
            turn: async (_profile: string, _session: string, prompt: string, options?: {attachments?: unknown[]}) => { attachments.push(structuredClone(options?.attachments ?? [])); prompts.push(prompt); await turnGate?.(); turn = `${id}-turn`; return { turnId: turn }; },
            read: async () => ({ session: { id }, turns: [{ id: turn, status: 'completed', items: [
                { id: `${turn}-text`, type: 'agentMessage', text: `RESULT:${id}` },
            ] }] }),
            subscribe: () => () => {}, close: async () => {},
            eventSnapshot: async () => ({ epoch: 'events', cursor: 2, gap: false, requests: [], events: [
                { seq: 1, message: { method: 'item/completed', params: { threadId: id, turnId: turn,
                    item: { id: `${turn}-text`, type: 'agentMessage', text: `RESULT:${id}` } } } },
                { seq: 2, message: { method: 'turn/completed', params: { threadId: id, turn: { id: turn, status: 'completed' } } } },
            ] }),
        } as unknown as HarnessClient;
        return { client, epoch: 'service', workspaceId: 'native-project', release: async () => {},
            profile: { id: 'claude', kind: 'claude', projectRuntime: true, workspaces: [{ id: 'native-project' }],
                capabilities: { create: true, history: true, interrupt: true, resume: true, interactions: true, fork: checkpointFork, checkpointFork, ...(attachmentKinds ? {attachments: attachmentKinds} : {}) } } };
    });
    await runtime.agentService.saveAgent({ id: 'remote-agent', name: 'Remote Agent', type: 'agent', config: { systemPrompt: 'REVIEW_INSTRUCTIONS' },
        execution: { kind: 'harness', connectionId: 'remote' } });
    return { runtime, prompts, sessions, fetch, forks, attachments };
}
async function send(runtime: Runtime, agentId: string, text: string, files: import('@itookit/llm-session/contracts').ChatAttachment[] = []) {
    const id = await runtime.sessionRepository.createSession('Remote execution');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    await runtime.commandBus.execute(SessionCommand.Send, { text, files, agentId,
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId, mode: 'agent' } } });
    await vi.waitFor(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        expect(rounds).toHaveLength(1); expect(rounds[0].status).toBe('completed');
    }, { timeout: 10_000 });
    return { id, tasks: await runtime.kernel.kernel.listSessionTasks(id), rounds: (await runtime.sessionRepository.readHistoryChain(id)).rounds };
}

function cancellationPeer(terminalStatus = 'interrupted') {
    let finished = false;
    const turn = vi.fn(async () => ({turnId: 'owned-turn'}));
    const interrupt = vi.fn(async () => {finished = true;});
    const client = {create: async () => ({session: {id: 'owned-native'}}), turn, interrupt,
        read: async () => ({session: {id: 'owned-native'}, turns: [{id: 'owned-turn', status: finished ? terminalStatus : 'inProgress', items: []}]}),
        subscribe: () => () => {}, close: async () => {},
        eventSnapshot: async () => ({epoch: 'events', cursor: finished ? 1 : 0, gap: false, requests: [], events: finished
            ? [{seq: 1, message: {method: 'turn/completed', params: {threadId: 'owned-native', turn: {id: 'owned-turn', status: terminalStatus}}}}] : []}),
    } as unknown as HarnessClient;
    return {client, turn, interrupt};
}

it('confirms real Runtime cancellation and releases its owned context through the production cleanup scope', async () => {
    const f = await setup(), peer = cancellationPeer(), acquire = vi.mocked(f.runtime.executionConnections.acquire).getMockImplementation()!;
    vi.mocked(f.runtime.executionConnections.acquire).mockImplementation(async snapshot => ({...await acquire(snapshot), client: peer.client}));
    const sessionId = await f.runtime.sessionRepository.createSession('Cancellation scope');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Private cancellation fixture', files: [], agentId: 'remote-agent'});
    await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
    const root = (await f.runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    const task = await f.runtime.kernel.kernel.openTask(root.id);
    await task.cancel('Stop owned execution');
    expect(await task.waitStopped({timeoutMs: 3000})).toMatchObject({stopped: true, settled: true, control: {acknowledged: true}});
    const saved = await (await f.runtime.kernel.kernel.inspectSession(sessionId)).getShared(CONTEXT_BINDINGS_KEY);
    const binding = Object.values((saved!.value as any).bindings)[0] as any;
    expect(binding.activeOperation).toBeUndefined(); expect(binding.knownHeadRef).toBe('owned-turn');
    expect(binding.checkpoints).toHaveLength(1); expect(peer.interrupt).toHaveBeenCalledOnce(); expect(peer.turn).toHaveBeenCalledOnce();
}, 20000);

it('dispatches the next queued Harness instruction only after confirmed cleanup and explicit queue resume', async () => {
    const f = await setup(), peer = cancellationPeer(), acquire = vi.mocked(f.runtime.executionConnections.acquire).getMockImplementation()!;
    vi.mocked(f.runtime.executionConnections.acquire).mockImplementation(async snapshot => ({...await acquire(snapshot), client: peer.client}));
    const sessionId = await f.runtime.sessionRepository.createSession('Queued cancellation');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'First instruction', files: [], agentId: 'remote-agent'});
    await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
    const next = await f.runtime.commandBus.execute<string>(SessionCommand.Send, {text: 'Next instruction', files: [], agentId: 'remote-agent'});
    const queue = () => f.runtime.sessionManager.getSnapshot().instructionQueue!;
    await f.runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: queue().revision, action: 'pause'});
    const root = (await f.runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    const task = await f.runtime.kernel.kernel.openTask(root.id); await task.cancel('Stop first instruction');
    expect(await task.waitStopped({timeoutMs: 3000})).toMatchObject({stopped: true, settled: true});
    await vi.waitFor(() => {expect(queue().paused).toBe(true); expect(queue().items.map(item => item.id)).toEqual([next]);});
    expect(peer.turn).toHaveBeenCalledOnce(); expect(f.prompts).toHaveLength(0);
    vi.mocked(f.runtime.executionConnections.acquire).mockImplementation(acquire);
    await f.runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: queue().revision, action: 'resume'});
    await vi.waitFor(async () => {
        const rounds = (await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
        expect(rounds).toHaveLength(2); expect(rounds[1]).toMatchObject({id: next, status: 'completed'}); expect(queue().items).toHaveLength(0);
    }, {timeout: 10000});
    const saved = await (await f.runtime.kernel.kernel.inspectSession(sessionId)).getShared(CONTEXT_BINDINGS_KEY);
    const bindings = Object.values((saved!.value as any).bindings) as any[];
    expect(bindings).toHaveLength(2); expect(bindings.every(binding => !binding.activeOperation && binding.checkpoints?.length === 1)).toBe(true);
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]).toContain('Next instruction'); expect(peer.interrupt).toHaveBeenCalledOnce();
}, 20000);

it('preserves a native completion racing with cancellation while confirming the real Kernel cleanup', async () => {
    const f = await setup(), peer = cancellationPeer('completed'), acquire = vi.mocked(f.runtime.executionConnections.acquire).getMockImplementation()!;
    vi.mocked(f.runtime.executionConnections.acquire).mockImplementation(async snapshot => ({...await acquire(snapshot), client: peer.client}));
    const sessionId = await f.runtime.sessionRepository.createSession('Native completion race');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Completion race input', files: [], agentId: 'remote-agent'});
    await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
    const root = (await f.runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    const task = await f.runtime.kernel.kernel.openTask(root.id); await task.cancel('Cancel raced with completed native turn');
    expect(await task.waitStopped({timeoutMs: 3000})).toMatchObject({stopped: true, settled: true});
    const session = await f.runtime.kernel.kernel.inspectSession(sessionId);
    const binding = Object.values(((await session.getShared(CONTEXT_BINDINGS_KEY))!.value as any).bindings)[0] as any;
    const journal = await session.getShared(harnessExecutionJournalKey({sessionId, taskId: root.id, effectId: binding.lastOperation.executionRef.effectId}));
    expect(journal?.value).toMatchObject({terminal: 'completed', turnId: 'owned-turn'});
    expect(binding.activeOperation).toBeUndefined(); expect(binding.checkpoints).toHaveLength(1); expect(peer.interrupt).toHaveBeenCalledOnce();
}, 20000);

it.each(['journal-write', 'release-lost-reply'])('recovers actual Kernel cleanup after %s without repeating the native operation', async stage => {
    const f = await setup(), peer = cancellationPeer(), kernel = f.runtime.kernel.kernel;
    const acquire = vi.mocked(f.runtime.executionConnections.acquire).getMockImplementation()!;
    vi.mocked(f.runtime.executionConnections.acquire).mockImplementation(async snapshot => ({...await acquire(snapshot), client: peer.client}));
    const sessionId = await f.runtime.sessionRepository.createSession('Cleanup persistence recovery');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Do not repeat this input', files: [], agentId: 'remote-agent'});
    await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
    const root = (await kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    const save = kernel.setShared.bind(kernel); let failed = false;
    const fault = vi.spyOn(kernel, 'setShared').mockImplementation(async (id, key, value, options) => {
        const matches = stage === 'journal-write' ? key.startsWith('harness.execution.') && (value as any).bindingSettlement
            : key === CONTEXT_BINDINGS_KEY && Object.values((value as any).bindings).some((binding: any) => binding.lastOperation && !binding.activeOperation);
        if (!failed && matches) {failed = true; if (stage === 'release-lost-reply') await save(id, key, value, options);
            throw Object.assign(new Error('Private storage failure'), {code: 'EIO'});}
        return save(id, key, value, options);
    });
    const task = await kernel.openTask(root.id); await expect(task.cancel('Stop with storage failure')).rejects.toThrow();
    expect(failed).toBe(true); expect(await task.stat()).toMatchObject({stopped: false, settled: false, control: {acknowledged: false}});
    expect((await task.status()).task.effects.harness.cleanupPending).toBe(true); fault.mockRestore();
    await (await kernel.openSession(sessionId)).recover();
    expect(await task.waitStopped({timeoutMs: 3000})).toMatchObject({stopped: true, settled: true, control: {acknowledged: true}});
    const saved = await (await kernel.inspectSession(sessionId)).getShared(CONTEXT_BINDINGS_KEY);
    const binding = Object.values((saved!.value as any).bindings)[0] as any;
    expect(binding.activeOperation).toBeUndefined(); expect(binding.checkpoints).toHaveLength(1);
    expect(peer.turn).toHaveBeenCalledOnce(); expect(peer.interrupt).toHaveBeenCalledOnce();
}, 20000);

it('executes an ordinary harness Agent through the real Program and broker without any local model', async () => {
    const f = await setup(), result = await send(f.runtime, 'remote-agent', 'Preserve ${param.literal}');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('Preserve ${param.literal}'); expect(f.prompts[0]).toContain('REVIEW_INSTRUCTIONS');
    expect(result.tasks.filter(task => task.program.kind === 'kernel-adapters.harness')).toHaveLength(1);
    expect(result.tasks.some(task => task.program.kind.startsWith('llm.'))).toBe(false);
    expect(JSON.stringify(result.rounds)).toContain('RESULT:native-0');
    const root = result.tasks.find(task => task.program.kind === 'kernel-adapters.harness')!;
    const input = root.input as unknown as {context: {invocationId: string; input: {mode: string; snapshotRef: string; digest: string}};
        contextSnapshot: {id: string; digest: string; blocks: unknown[]}; messages: unknown[]};
    expect(input.context.invocationId).toBe(result.rounds[0].executions[0].invocation!.invocationId);
    expect(input.context.input.mode).toBe('host-assembled');
    expect(input.contextSnapshot.id).toBe(input.context.input.snapshotRef); expect(input.contextSnapshot.digest).toBe(input.context.input.digest);
    expect(input.contextSnapshot.blocks.length).toBeGreaterThan(0); expect(input.messages.length).toBeGreaterThan(0);
    const saved = await (await f.runtime.kernel.kernel.inspectSession(result.id)).getShared(CONTEXT_BINDINGS_KEY);
    const bindings = Object.values((saved!.value as any).bindings) as any[];
    expect(bindings).toHaveLength(1); expect(bindings[0]).toMatchObject({sessionId: result.id, validity: 'valid', nativeRef: {sessionId: 'native-0'}});
    expect(bindings[0].activeOperation).toBeUndefined();
    expect((root.output as any).harness.contextBinding.bindingId).toBe(bindings[0].id);
});

it('keeps host-assembled context ownership explicit on subsequent conversation rounds', async () => {
    const f = await setup(), first = await send(f.runtime, 'remote-agent', 'First turn');
    await vi.waitFor(() => expect(f.runtime.sessionManager.isGenerating()).toBe(false));
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Second turn', files: [], agentId: 'remote-agent',
        sendIntent: {branch: {mode: 'continue'}, retention: {mode: 'persistent'}, execution: {kind: 'agent', agentId: 'remote-agent', mode: 'agent'}}});
    await vi.waitFor(async () => {
        const rounds = (await f.runtime.sessionRepository.readHistoryChain(first.id)).rounds;
        expect(rounds).toHaveLength(2); expect(rounds[1].status).toBe('completed');
    });
    const saved = await (await f.runtime.kernel.kernel.inspectSession(first.id)).getShared(CONTEXT_BINDINGS_KEY);
    const bindings = Object.values((saved!.value as any).bindings) as any[];
    expect(bindings).toHaveLength(2); expect(new Set(bindings.map(binding => binding.id)).size).toBe(2);
    expect(f.sessions).toEqual(['native-0', 'native-1']);
    expect(f.prompts[1]).toContain('RESULT:native-0');
    expect(bindings.every(binding => binding.initialContext.mode === 'host-assembled' && !binding.activeOperation)).toBe(true);
});

it('queries the binding produced by an actual Harness Agent after the view is unbound without acquiring native execution', async () => {
    const f = await setup(), result = await send(f.runtime, 'remote-agent', 'Private context query source');
    await vi.waitFor(() => expect(f.runtime.sessionManager.isGenerating()).toBe(false));
    await f.runtime.commandBus.execute(SessionCommand.Unbind);
    const open = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    const activatingRead = vi.spyOn(f.runtime.kernel.kernel, 'getShared');
    const page = await f.runtime.commandBus.execute<ContextBindingPage>(SessionCommand.ContextBindings, {sessionId: result.id});
    expect(page.bindings).toHaveLength(1); expect(page.bindings[0]).toMatchObject({busy: false, validity: 'valid', checkpointCount: 1});
    const checkpoints = await f.runtime.commandBus.execute<ContextBindingPage>(SessionCommand.ContextBindings,
        {sessionId: result.id, bindingId: page.bindings[0].ref.bindingId});
    expect(checkpoints.checkpoints).toEqual([{kind: 'terminal', ref: 'native-0-turn', invocationId: result.rounds[0].executions[0].invocation!.invocationId}]);
    expect(JSON.stringify(page)).not.toContain('Private context query source'); expect(JSON.stringify(page)).not.toContain('nativeRef');
    expect(open).not.toHaveBeenCalled(); expect(activatingRead).not.toHaveBeenCalled();
    expect(f.runtime.executionConnections.acquire).toHaveBeenCalledOnce(); expect(f.prompts).toHaveLength(1);
    expect(f.runtime.sessionManager.getCurrentSessionId()).toBeNull();
});

it('dispatches a queued explicit checkpoint fork with increment-only input and a new binding', async () => {
    const f = await setup(true), first = await send(f.runtime, 'remote-agent', 'First request');
    await vi.waitFor(() => expect(f.runtime.sessionManager.isGenerating()).toBe(false));
    const handle = await f.runtime.kernel.kernel.inspectSession(first.id), saved = await handle.getShared(CONTEXT_BINDINGS_KEY);
    const source = Object.values((saved!.value as any).bindings)[0] as any;
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Only this increment', files: [], agentId: 'remote-agent',
        overrides: {harnessConversation: {mode: 'fork', sourceBindingId: source.id, expectedBindingRevision: source.revision,
            expectedGeneration: source.generation, checkpointRef: source.knownHeadRef}},
        sendIntent: {branch: {mode: 'continue'}, retention: {mode: 'persistent'}, execution: {kind: 'agent', agentId: 'remote-agent', mode: 'agent'}}});
    await vi.waitFor(async () => {
        const rounds = (await f.runtime.sessionRepository.readHistoryChain(first.id)).rounds;
        expect(rounds).toHaveLength(2); expect(rounds[1].status).toBe('completed');
    });
    expect(f.forks).toEqual([{source: 'native-0', checkpoint: 'native-0-turn'}]);
    expect(f.prompts[1]).toBe('Only this increment');
    const records = (await handle.getShared(CONTEXT_BINDINGS_KEY))!.value as any;
    expect(records.bindings[source.id]).toEqual(source);
    const next = Object.values(records.bindings).find((binding: any) => binding.id !== source.id) as any;
    expect(next).toMatchObject({forkedFrom: {bindingId: source.id, checkpointRef: source.knownHeadRef}, validity: 'valid'});
    expect(next.activeOperation).toBeUndefined(); expect(next.id).not.toBe(source.id);
    const tasks = await f.runtime.kernel.kernel.listSessionTasks(first.id);
    const input = tasks.find(task => task.labels?.invocationId === next.lastOperation.invocationId)!.input as any;
    expect(input.context.input.mode).toBe('native-continuation'); expect(input.messages).toBeUndefined();
});

it('runs parallel Flow Agent nodes as independent native sessions and joins their actual results', async () => {
    const f = await setup();
    const flow: FlowDraft = { id: 'remote-workers', name: 'Remote workers', draftVersion: 1, updatedAt: 0,
        nodes: ['one', 'two'].map(id => ({ id, name: id, plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { agentId: 'remote-agent', historyPolicy: 'none', instruction: `${id}: \${input.prompt}` }, inputs: {} })),
        edges: [], outputs: { first: { value: '${nodes.one.outputs.result}' }, second: { value: '${nodes.two.outputs.result}' } } } as FlowDraft;
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [flow] });
    await f.runtime.agentService.saveAgent({ id: 'flow-agent', name: 'Remote workers', type: 'workflow', config: {}, execution: { kind: 'flow', flowId: flow.id } });
    const result = await send(f.runtime, 'flow-agent', 'Check the project');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.sessions).toHaveLength(2); expect(new Set(f.sessions).size).toBe(2);
    expect(f.prompts).toHaveLength(2); expect(f.prompts.some(text => text.includes('one: Check the project'))).toBe(true);
    expect(f.prompts.some(text => text.includes('two: Check the project'))).toBe(true);
    expect(result.tasks.filter(task => task.program.kind === 'kernel-adapters.harness' && task.status === 'succeeded')).toHaveLength(2);
    expect(JSON.stringify(result.rounds)).toContain('RESULT:native-0'); expect(JSON.stringify(result.rounds)).toContain('RESULT:native-1');
});

it('applies the frozen Harness prompt append and rejects a fork after the actual system policy changes', async () => {
    const f = await setup(true), sessionId = await f.runtime.sessionRepository.createSession('Native policy override');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'First request', files: [], agentId: 'remote-agent',
        overrides: {systemPromptAppend: 'PRIVATE_NATIVE_POLICY_A'}});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'));
    expect(f.prompts[0].split('PRIVATE_NATIVE_POLICY_A')).toHaveLength(2);
    const session = await f.runtime.kernel.kernel.inspectSession(sessionId);
    const source = Object.values(((await session.getShared(CONTEXT_BINDINGS_KEY))!.value as any).bindings)[0] as any;
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Second request', files: [], agentId: 'remote-agent',
        overrides: {systemPromptAppend: 'PRIVATE_NATIVE_POLICY_B', harnessConversation: {mode: 'fork', sourceBindingId: source.id,
            expectedBindingRevision: source.revision, expectedGeneration: source.generation, checkpointRef: source.knownHeadRef}}});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[1]?.status).toBe('failed'));
    expect(f.forks).toEqual([]); expect(f.sessions).toHaveLength(1); expect(f.prompts).toHaveLength(1);
    const tasks = await f.runtime.kernel.kernel.listSessionTasks(sessionId);
    expect(tasks.some(task => task.status === 'failed' && JSON.stringify(task.exit).includes('CONTEXT_POLICY_CHANGED'))).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
}, 20000);

async function publishAssetFlow(runtime: Runtime, id: string, images: boolean) {
    const flow: FlowDraft = {id, name: 'Asset worker', draftVersion: 1, updatedAt: 0,
        parameters: [{name: 'files', type: 'json', required: true, ...(images ? {widget: 'images', inputSource: 'composer.attachments'} : {})}],
        nodes: [{id: 'worker', name: 'Worker', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
            agentId: 'remote-agent', historyPolicy: 'none', messageTemplates: [{role: 'user', content: '${param.files}'}],
        }}], edges: [], outputs: {result: {value: '${nodes.worker.outputs.result}'}}} as FlowDraft;
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
}

it('delivers a generic uploaded text argument to the actual consuming native worker', async () => {
    const f = await setup(false, ['text']), data = new TextEncoder().encode('\ufeffUploaded selection').buffer;
    const asset = await f.runtime.commandBus.execute(InputAssetCommand.ImportFile, {uploadId: '12345678-1234-4123-8123-123456789abc',
        name: 'notes.txt', mimeType: 'text/plain', bytes: data.byteLength, sha256: await sha256Hex(data), data});
    await publishAssetFlow(f.runtime, 'generic-file-flow', false);
    const sessionId = await f.runtime.sessionRepository.createSession('Generic native files'); await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'generic-file-flow', version: '1'},
        source: {kind: 'arguments', value: {files: [{type: 'file', name: 'notes.txt', source: {type: 'asset', asset}}]}}});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'));
    expect(f.attachments).toEqual([[{kind: 'text', name: 'notes.txt', mimeType: 'text/plain', content: '\ufeffUploaded selection'}]]);
    expect(f.prompts).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
});

it('resolves a Flow composer image reference through the real Task asset reader at native dispatch', async () => {
    const f = await setup(false, ['image']), url = 'data:image/png;base64,iVBORw0KGgo=';
    const asset = await f.runtime.commandBus.execute(InputAssetCommand.Import, {url});
    const part = {type: 'image', name: 'page.png', source: {type: 'asset', asset}};
    await publishAssetFlow(f.runtime, 'native-image-flow', true);
    const sessionId = await f.runtime.sessionRepository.createSession('Native file Flow');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'native-image-flow', version: '1'},
        source: {kind: 'composer', text: '', attachments: [part], values: {}}});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'), {timeout: 10000});
    const task = (await f.runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    expect(task.status).toBe('succeeded'); expect(JSON.stringify(task.input)).toContain((asset as {id: string}).id);
    expect(JSON.stringify(task.input)).not.toContain('iVBORw0KGgo=');
    expect(f.attachments).toMatchObject([[{kind: 'image', name: 'page.png', mimeType: 'image/png', content: url}]]);
    expect(f.sessions).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
});

it('passes a file produced by a deterministic Tool to a native worker inside the same Flow', async () => {
    const tool = buildTool({name: 'FixtureAsset', version: '1.0.0', inputSchema: TaskListTool.inputSchema,
        description: async () => 'Fixture file producer', prompt: async () => '',
        call: async (_args, context) => ({data: [{type: 'file', name: 'notes.txt', source: {
            type: 'asset', asset: await context.writeAsset!(new TextEncoder().encode('\ufeffSelected tool file'), 'text/plain'),
        }}]}),
    });
    const f = await setup(false, ['text'], undefined, [tool]);
    const flow: FlowDraft = {id: 'native-tool-file', name: 'Tool and native worker', draftVersion: 1, updatedAt: 0,
        nodes: [{id: 'source', name: 'Source', plugin: 'builtin.tool', pluginVersion: '1.0.0', capabilities: ['FixtureAsset'],
            config: {toolId: 'FixtureAsset', toolVersion: '1.0.0', args: {}, approval: 'none'}, inputs: {}},
        {id: 'worker', name: 'Worker', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
            agentId: 'remote-agent', historyPolicy: 'none', includeDependencyOutputs: false,
            messageTemplates: [{role: 'user', content: '${nodes.source.outputs.result}'}],
        }}], edges: [], outputs: {result: {value: '${nodes.worker.outputs.result}'}}} as FlowDraft;
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const sessionId = await f.runtime.sessionRepository.createSession('Tool asset Flow');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: flow.id, version: '1'}, source: {kind: 'arguments', value: {}}});
    try {
        await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'), {timeout: 8000});
    } catch {
        const tasks = await f.runtime.kernel.kernel.listSessionTasks(sessionId);
        throw new Error(JSON.stringify(tasks.map(task => ({program: task.program.kind, status: task.status, error: task.exit?.error,
            interactionCount: Object.keys(task.interactions).length}))));
    }
    expect(f.attachments).toEqual([[{kind: 'text', name: 'notes.txt', mimeType: 'text/plain', content: '\ufeffSelected tool file'}]]);
    const tasks = await f.runtime.kernel.kernel.listSessionTasks(sessionId), consumer = tasks.find(task => task.program.kind === 'kernel-adapters.harness')!;
    expect(consumer.status).toBe('succeeded'); expect(JSON.stringify(consumer.input)).not.toContain('Selected tool file');
    expect(tasks.find(task => task.program.kind === 'kernel-adapters.tool')?.status).toBe('succeeded');
    expect(f.sessions).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
}, 20000);

it('refuses a Task file from an unrelated invocation before creating another native session', async () => {
    const f = await setup(false, ['text']), first = await send(f.runtime, 'remote-agent', 'Produce a source');
    const sourceTask = first.tasks.find(task => task.program.kind === 'kernel-adapters.harness')!;
    const asset = await createTaskAssetStore(() => f.runtime.kernel.kernel).write(new TextEncoder().encode('Private source'), 'text/plain', {
        sessionId: first.id, taskId: sourceTask.id, effectId: 'source-file', operationId: 'source-file',
    });
    await publishAssetFlow(f.runtime, 'foreign-asset-flow', false);
    await expect(f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'foreign-asset-flow', version: '1'},
        source: {kind: 'arguments', value: {files: [{type: 'file', name: 'notes.txt', source: {type: 'asset', asset}}]}}}))
        .rejects.toMatchObject({code: 'ASSET_INPUT_TRANSFER_REQUIRED'});
    expect((await f.runtime.sessionRepository.readHistoryChain(first.id)).rounds).toHaveLength(1);
    expect((await f.runtime.kernel.kernel.listSessionTasks(first.id)).length).toBe(first.tasks.length);
    expect(f.sessions).toHaveLength(1); expect(f.prompts).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
});

it('sends verified text and images as native attachments while keeping history references separate', async () => {
    const f = await setup(false, ['text', 'image']);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yAAAAABJRU5ErkJggg==', 'base64');
    const first = await send(f.runtime, 'remote-agent', 'Review these files', [
        {name: 'notes.txt', type: 'text/plain', fileRef: new Blob(['UNIQUE_NATIVE_TEXT'])},
        {name: 'pixel.png', type: 'image/png', fileRef: new Blob([png])},
    ]);
    expect(f.attachments[0]).toMatchObject([{kind: 'text', content: 'UNIQUE_NATIVE_TEXT'},
        {kind: 'image', mimeType: 'image/png', content: 'data:image/png;base64,' + png.toString('base64')}]);
    expect(f.prompts[0]).not.toContain('UNIQUE_NATIVE_TEXT');
    expect(JSON.stringify(first.rounds[0].input)).not.toContain('UNIQUE_NATIVE_TEXT');
    const input = first.tasks.find(task => task.program.kind === 'kernel-adapters.harness')!.input as any;
    expect(input.messages.at(-1).attachments).toMatchObject([{type: 'text', source: 'UNIQUE_NATIVE_TEXT'}, {type: 'image'}]);
    expect(input.context.input.mode).toBe('host-assembled'); expect(f.fetch).not.toHaveBeenCalled();
});

it('forks with only the new verified attachment instead of injecting historical files again', async () => {
    const f = await setup(true, ['text']);
    const first = await send(f.runtime, 'remote-agent', 'Old request', [{name: 'old.txt', type: 'text/plain', fileRef: new Blob(['OLD_FILE_BODY'])}]);
    await vi.waitFor(() => expect(f.runtime.sessionManager.isGenerating()).toBe(false));
    const handle = await f.runtime.kernel.kernel.inspectSession(first.id), saved = await handle.getShared(CONTEXT_BINDINGS_KEY);
    const source = Object.values((saved!.value as any).bindings)[0] as any;
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'New increment',
        files: [{name: 'new.txt', type: 'text/plain', fileRef: new Blob(['NEW_FILE_BODY'])}], agentId: 'remote-agent',
        overrides: {harnessConversation: {mode: 'fork', sourceBindingId: source.id, expectedBindingRevision: source.revision,
            expectedGeneration: source.generation, checkpointRef: source.knownHeadRef}},
        sendIntent: {branch: {mode: 'continue'}, retention: {mode: 'persistent'}, execution: {kind: 'agent', agentId: 'remote-agent', mode: 'agent'}}});
    await vi.waitFor(async () => {const rounds = (await f.runtime.sessionRepository.readHistoryChain(first.id)).rounds;
        expect(rounds).toHaveLength(2); expect(rounds[1].status).toBe('completed');});
    expect(f.prompts[1]).toBe('New increment'); expect(f.attachments[1]).toMatchObject([{kind: 'text', content: 'NEW_FILE_BODY'}]);
    expect(f.attachments[1]).toHaveLength(1); expect(JSON.stringify(f.attachments[1])).not.toContain('OLD_FILE_BODY');
    const task = (await f.runtime.kernel.kernel.listSessionTasks(first.id)).find(task => (task.input as any).prompt === 'New increment')!;
    expect((task.input as any).messages).toBeUndefined(); expect((task.input as any).contextSnapshot).toBeUndefined();
    expect((task.input as any).attachments).toMatchObject([{content: 'NEW_FILE_BODY'}]);
});

it('durably dispatches an image at the declared native byte limit without a local model call', async () => {
    const f = await setup(false, ['image']), image = new Uint8Array(256 * 1024);
    image.set(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yAAAAABJRU5ErkJggg==', 'base64'));
    await send(f.runtime, 'remote-agent', '', [{name: 'limit.png', type: 'image/png', fileRef: new Blob([image])}]);
    expect(f.attachments[0]).toHaveLength(1);
    const content = (f.attachments[0][0] as {content: string}).content.split(',')[1];
    expect(Buffer.from(content, 'base64')).toEqual(Buffer.from(image)); expect(f.fetch).not.toHaveBeenCalled();
});

it('accepts and edits the next file instruction while the original native turn acknowledgement is suspended', async () => {
    let release!: () => void, calls = 0;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const f = await setup(false, ['text'], () => ++calls === 1 ? pending : Promise.resolve());
    let queued: Promise<unknown> | undefined;
    try {
        const id = await f.runtime.sessionRepository.createSession('Native file queue');
        await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Hold acknowledgement', files: [], agentId: 'remote-agent'});
        await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
        queued = f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Queued file',
            files: [{name: 'notes.txt', type: 'text/plain', fileRef: new Blob(['QUEUED_FILE_BODY'])}], agentId: 'remote-agent'});
        void queued.catch(() => {});
        await vi.waitFor(() => expect(f.runtime.sessionManager.getSnapshot().instructionQueue?.items).toHaveLength(2));
        const nextId = await queued;
        const queue = f.runtime.sessionManager.getSnapshot().instructionQueue!;
        await f.runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: queue.revision, action: 'update', id: nextId, text: 'Edited queued file'});
        expect(f.prompts).toHaveLength(1); release();
        await vi.waitFor(async () => {const rounds = (await f.runtime.sessionRepository.readHistoryChain(id)).rounds;
            expect(rounds).toHaveLength(2); expect(rounds.every(round => round.status === 'completed')).toBe(true);}, {timeout: 10000});
        expect(f.prompts[1]).toContain('Edited queued file');
        expect(f.attachments[1]).toMatchObject([{kind: 'text', content: 'QUEUED_FILE_BODY'}]); expect(f.fetch).not.toHaveBeenCalled();
    } finally {release(); await queued?.catch(() => {});}
}, 20000);

it.each(['interrupted', 'completed'])('confirms runtime cleanup and preserves the observed native %s outcome', async terminal => {
    const f = await setup(), peer = cancellationPeer(terminal), release = vi.fn(async () => {});
    const acquire = vi.mocked(f.runtime.executionConnections.acquire).getMockImplementation()!;
    vi.mocked(f.runtime.executionConnections.acquire).mockImplementation(async snapshot => ({...await acquire(snapshot), client: peer.client, release}));
    const sessionId = await f.runtime.sessionRepository.createSession('Owned cleanup');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Cleanup fixture', files: [], agentId: 'remote-agent'});
    await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
    const root = (await f.runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    const task = await f.runtime.kernel.kernel.openTask(root.id);
    await task.cancel('Stop owned execution');
    expect(await task.waitStopped({timeoutMs: 3000})).toMatchObject({stopped: true, settled: true, control: {acknowledged: true}});
    const journal = await (await f.runtime.kernel.kernel.inspectSession(sessionId)).getShared(harnessExecutionJournalKey({sessionId, taskId: root.id, effectId: 'harness'}));
    expect(journal?.value).toMatchObject({sessionId: 'owned-native', turnId: 'owned-turn', terminal: terminal === 'completed' ? 'completed' : 'cancelled'});
    expect(peer.interrupt).toHaveBeenCalledOnce(); expect(peer.turn).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(vi.mocked(f.runtime.executionConnections.acquire).mock.calls.length);
}, 10000);

it('freezes a queued fork selection but revalidates source revision before dispatch', async () => {
    const f = await setup(true), first = await send(f.runtime, 'remote-agent', 'Initial context');
    await vi.waitFor(() => expect(f.runtime.sessionManager.isGenerating()).toBe(false));
    const session = await f.runtime.kernel.kernel.openSession(first.id), saved = (await session.getShared(CONTEXT_BINDINGS_KEY))!;
    const collection = structuredClone(saved.value) as any, source = Object.values(collection.bindings)[0] as any;
    const selection = {mode: 'fork' as const, sourceBindingId: source.id, expectedBindingRevision: source.revision,
        expectedGeneration: source.generation, checkpointRef: source.knownHeadRef};
    const queue = () => f.runtime.sessionManager.getSnapshot().instructionQueue!;
    await f.runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: queue().revision, action: 'pause'});
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Queued increment', files: [], agentId: 'remote-agent',
        overrides: {harnessConversation: selection}});
    selection.checkpointRef = 'later caller mutation';
    expect(queue().items[0].overrides?.harnessConversation?.mode).toBe('fork');
    expect((queue().items[0].overrides?.harnessConversation as any).checkpointRef).toBe(source.knownHeadRef);
    source.revision++;
    await session.setShared(CONTEXT_BINDINGS_KEY, collection, {expectedVersion: saved.version});
    await f.runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: queue().revision, action: 'resume'});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(first.id)).rounds[1]?.status).toBe('failed'));
    expect(f.forks).toEqual([]); expect(f.sessions).toHaveLength(1); expect(f.prompts).toHaveLength(1);
    const tasks = await f.runtime.kernel.kernel.listSessionTasks(first.id);
    expect(tasks.some(task => task.status === 'failed' && JSON.stringify(task.exit).includes('CONTEXT_BINDING_CHANGED'))).toBe(true);
}, 20000);

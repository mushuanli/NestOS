import {ConversationContexts} from '../src/runtime/conversation-contexts';
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {ArtifactCommand, type ExecutionArtifactPage, type ExecutionArtifactChunk, FlowLibraryCommand} from '@itookit/app-contracts';
import {IndependentCallCommand, SessionCommand, type IndependentCallView, type IndependentCallInput, type IndependentCallReceipt, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function fixture(model = false, bind = true, wait = false) {
    const backend = new MemoryBackend(), prompts: string[] = [];
    if (model) {
        await backend.init();
        for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
        const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
        await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture',
            baseURL: 'https://fixture.invalid', models: [{id: 'mock-model', name: 'Mock'}]});
        await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'mock-model'}});
        await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            const body = JSON.parse(options.body); prompts.push(JSON.stringify(body.messages));
            const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({id: 'response', choices: [{index: 0, delta, finish_reason}]})}\n\n`;
            return new Response(chunk({role: 'assistant', content: 'Done'}, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
        }));
    }
    const runtime = await createApplicationRuntime({backend, ownerKind: 'tauri', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [{id: 'independent', name: 'Independent', exposure: 'global',
        draftVersion: 1, updatedAt: 0, layout: {}, parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'}],
        nodes: [{id: 'return', name: 'Return', plugin: wait ? 'builtin.human' : 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: wait ? {requestId: 'approval', prompt: 'Wait'} : {value: 'done'}}],
        edges: [], outputs: {result: {value: wait ? '${nodes.return.outputs.response}' : '${nodes.return.outputs.result}'}}}]});
    await runtime.agentService.saveAgent(model ? {id: 'worker', name: 'Worker', type: 'agent', config: {}}
        : {id: 'worker', name: 'Worker', type: 'workflow', config: {}, execution: {kind: 'flow', flowId: 'independent'}});
    const parent = await runtime.sessionRepository.createSession('Caller');
    if (bind) await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: parent});
    const catalog = await runtime.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const input = (id: string, kind: 'agent' | 'flow' = 'agent'): IndependentCallInput => {
        const target = catalog.entries.find(entry => entry.target.kind === kind && entry.target.id === (kind === 'agent' ? 'worker' : 'independent'))!.target;
        return {title: 'Independent work', request: {expectedSessionId: parent, expectedBranch: 'main', target: {kind: target.kind, id: target.id, version: target.version}, expectedTarget: target,
            source: {kind: 'composer', text: 'Run separately', values: {}, attachments: []},
            submission: {id, source: {kind: 'conversation', ownerId: parent, id}}}};
    };
    const submit = (call: IndependentCallInput) => runtime.commandBus.execute<IndependentCallReceipt>(IndependentCallCommand.Submit, call);
    const inspect = (call: IndependentCallInput) => runtime.commandBus.execute<IndependentCallReceipt>(IndependentCallCommand.Inspect, call);
    return {runtime, parent, input, submit, inspect, prompts, backend};
}

it.each(['agent', 'flow'] as const)('routes an independent %s to its own Session without rebinding or queuing the parent', async kind => {
    const f = await fixture(), input = f.input('separate-call', kind);
    const first = await f.submit(input);
    expect(first).toMatchObject({operationId: 'separate-call', callerSessionId: f.parent, status: 'accepted'});
    expect(first.executionSessionId).not.toBe(f.parent);
    await vi.waitFor(async () => {
        const rounds = (await f.runtime.sessionRepository.readHistoryChain(first.executionSessionId!)).rounds;
        expect(rounds).toHaveLength(1); expect(rounds[0].status).toBe('completed');
    }, {timeout: 10000});
    const observed = await f.inspect(input);
    expect(observed.execution?.invocation?.invocationId).toBeTruthy();
    expect(observed.execution?.taskId).toBeTruthy();
    expect(await f.submit(input)).toEqual(observed);
    expect((await f.runtime.sessionRepository.getManifest(first.executionSessionId!)).parentSessionId).toBe(f.parent);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.parent)).rounds).toEqual([]);
    expect(await f.runtime.commandBus.execute(SessionCommand.GetCurrentId)).toBe(f.parent);
    const second = await f.submit(f.input('second-call', kind));
    expect(second.executionSessionId).not.toBe(first.executionSessionId);
}, 15000);

it('reads absent and accepted routes without opening a writer or a conversation view', async () => {
    const f = await fixture(), input = f.input('receipt-call');
    const open = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    expect(await f.inspect(input)).toMatchObject({status: 'unknown'});
    expect(open).not.toHaveBeenCalled(); open.mockRestore();
    const accepted = await f.submit(input);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    const readonly = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    expect(await f.inspect(input)).toMatchObject({status: 'accepted', executionSessionId: accepted.executionSessionId});
    expect(readonly).not.toHaveBeenCalled();
    await expect(f.inspect({...input, title: 'Different intent'})).rejects.toMatchObject({code: 'CALL_REQUEST_CONFLICT'});
    const changedSource = structuredClone(input); changedSource.request.submission!.source.id = 'another-source';
    await expect(f.inspect(changedSource)).rejects.toMatchObject({code: 'CALL_REQUEST_CONFLICT'});
}, 15000);

it('copies declared attachments into the child and reconciles without rereading the caller assets', async () => {
    const f = await fixture(), input = f.input('attachment-call');
    await f.runtime.sessionRepository.writeAttachment(f.parent, 'first.txt', new TextEncoder().encode('first').buffer);
    await f.runtime.sessionRepository.writeAttachment(f.parent, 'second.txt', new TextEncoder().encode('second').buffer);
    input.request.attachments = [{name: 'first.txt', type: 'text/plain'}, {name: 'second.txt', type: 'text/plain'}];
    const accepted = await f.submit(input);
    const originalRead = f.runtime.sessionRepository.readSessionAsset.bind(f.runtime.sessionRepository);
    vi.spyOn(f.runtime.sessionRepository, 'readSessionAsset').mockImplementation(async (id, name) => {
        if (id === f.parent) throw new Error('Caller assets unavailable after acceptance');
        return originalRead(id, name);
    });
    expect(await f.submit(input)).toMatchObject({executionSessionId: accepted.executionSessionId, status: 'accepted'});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds).toHaveLength(1);
}, 15000);


it('reconciles a lost child admission reply and preserves the caller binding', async () => {
    const f = await fixture(), input = f.input('lost-child-reply');
    const open = ConversationContexts.prototype.open;
    let submissions = 0;
    vi.spyOn(ConversationContexts.prototype, 'open').mockImplementation(async function (id) {
        const context = await open.call(this, id), submit = context.sessionManager.submit.bind(context.sessionManager);
        vi.spyOn(context.sessionManager, 'submit').mockImplementationOnce(async request => {
            ++submissions; await submit(request); throw new Error('Lost child admission reply');
        });
        return context;
    });
    const accepted = await f.submit(input);
    expect(accepted.status).toBe('accepted'); expect(submissions).toBe(1);
    expect(await f.submit(input)).toMatchObject({status: 'accepted', executionSessionId: accepted.executionSessionId});
    expect(submissions).toBe(1);
    expect(await f.runtime.commandBus.execute(SessionCommand.GetCurrentId)).toBe(f.parent);
}, 15000);

it('allows concurrent same-call submission but refuses conflicting input without a second child', async () => {
    const f = await fixture(), input = f.input('concurrent-call');
    const [a, b] = await Promise.all([f.submit(input), f.submit(structuredClone(input))]);
    expect(a.executionSessionId).toBe(b.executionSessionId); expect(a.status).toBe('accepted'); expect(b.status).toBe('accepted');
    await expect(f.submit({...input, title: 'Different'})).rejects.toMatchObject({code: 'CALL_REQUEST_CONFLICT'});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(a.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    expect((await f.runtime.sessionRepository.readHistoryChain(a.executionSessionId!)).rounds).toHaveLength(1);
}, 15000);


it('runs a direct model Agent in a child without implicitly inheriting parent conversation history', async () => {
    const f = await fixture(true), parentInput = f.input('parent-message').request;
    parentInput.source = {kind: 'composer', text: 'PARENT_PRIVATE_HISTORY', values: {}, attachments: []};
    await f.runtime.commandBus.execute(SessionCommand.Submit, parentInput);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(f.parent)).rounds[0]?.status).toBe('completed'));
    const child = await f.submit(f.input('model-child'));
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(child.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    expect(f.prompts).toHaveLength(2); expect(f.prompts[0]).toContain('PARENT_PRIVATE_HISTORY');
    expect(f.prompts[1]).toContain('Run separately'); expect(f.prompts[1]).not.toContain('PARENT_PRIVATE_HISTORY');
    expect((await f.inspect(f.input('model-child'))).execution?.invocation?.invocationId).toBeTruthy();
}, 15000);

it('prepares execution storage for an explicit caller without requiring a bound UI view', async () => {
    const f = await fixture(false, false), input = f.input('unbound-caller');
    const before = await f.inspect(input); expect(before.status).toBe('unknown');
    const accepted = await f.submit(input); expect(accepted.status).toBe('accepted');
    expect(accepted.executionSessionId).not.toBe(f.parent);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.parent)).rounds).toEqual([]);
}, 15000);


it('recovers the same route and actual execution identity after host restart without another submission', async () => {
    const f = await fixture(), input = f.input('recovered-route');
    const keep = vi.spyOn(f.backend, 'close').mockResolvedValue(undefined);
    try {
        const accepted = await f.submit(input);
        await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds[0]?.status).toBe('completed'));
        const original = await f.inspect(input);
        await f.runtime.dispose();
        const restored = await createApplicationRuntime({backend: f.backend, ownerKind: 'tauri', digitalTwinAutoStart: false});
        cleanup.push(() => restored.dispose());
        expect(await restored.commandBus.execute(IndependentCallCommand.Inspect, input)).toEqual(original);
        expect(await restored.commandBus.execute(IndependentCallCommand.Submit, input)).toEqual(original);
        expect((await restored.sessionRepository.readHistoryChain(original.executionSessionId!)).rounds).toHaveLength(1);
    } finally {keep.mockRestore();}
}, 15000);


it('lists actual child results in the caller branch without acquiring a writer', async () => {
    const f = await fixture(true), input = f.input('listed-child');
    const accepted = await f.submit(input);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    const open = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    const list = () => f.runtime.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent, branchId: 'main'});
    const views = await list();
    expect(open).not.toHaveBeenCalled();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({input, head: null, status: 'completed', summary: 'Done',
        receipt: {status: 'accepted', executionSessionId: accepted.executionSessionId}});
    expect(views[0].receipt.execution?.taskId).toBeTruthy();
    expect(views[0].executionState).toMatchObject({id: views[0].receipt.execution!.taskId, phase: 'done', settled: true, stopped: true, activeOperations: 0, controlEpoch: 0});
    expect(views[0].executionTree).toMatchObject({taskId: views[0].receipt.execution!.taskId, unsettledTasks: 0, settled: true, stopped: true, activeOperations: 0});
    expect(views[0].executionTree!.tasks).toBeGreaterThan(0); expect(views[0].executionTree!.asOfSequence).toBeGreaterThan(0);
    expect(views[0].controlCapabilities).toEqual({cancel: true, respond: true, pause: 'boundary', resume: true, withdrawPause: true});
    expect(views[0].executionState).not.toHaveProperty('exit');
    expect(views[0].executionState).not.toHaveProperty('output');
    expect(views[0].createdAt).toBeGreaterThan(0);
    views[0].input.title = 'Mutated view';
    expect((await list())[0].input.title).toBe(input.title);
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.List, {sessionId: f.parent, branchId: 'missing'})).rejects.toMatchObject({code: 'CALL_BRANCH_CHANGED'});
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.List, {sessionId: f.parent, extra: true})).rejects.toMatchObject({code: 'CALL_QUERY_INVALID'});
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.List, {sessionId: accepted.executionSessionId})).toEqual([]);
}, 15000);

it('lists an uninitialized caller without creating Kernel storage', async () => {
    const f = await fixture(false, false), open = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.List, {sessionId: f.parent})).toEqual([]);
    expect(open).not.toHaveBeenCalled();
});


it('bounds terminal previews and rejects a child Round attributed to another caller', async () => {
    const f = await fixture(true), input = f.input('verified-output'), accepted = await f.submit(input);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    const repository = f.runtime.sessionRepository, child = accepted.executionSessionId!, name = 'round-verified-output.json';
    const round = JSON.parse((await repository.readDocument(child, name))!);
    round.output = [{role: 'assistant', content: 'x'.repeat(3000)}];
    await repository.writeDocument(child, name, JSON.stringify(round));
    const list = () => f.runtime.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent});
    expect((await list())[0].summary).toHaveLength(2000);
    round.submission.source.ownerId = 'foreign-caller';
    await repository.writeDocument(child, name, JSON.stringify(round));
    await expect(list()).rejects.toMatchObject({code: 'CALL_EXECUTION_CONFLICT'});
}, 15000);


it.each(['flow', 'agent'] as const)('reads independent %s output through its actual child task while keeping the parent bound', async kind => {
    const f = await fixture(kind === 'agent'), input = f.input('child-artifact', kind), accepted = await f.submit(input);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(accepted.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    const calls = await f.runtime.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent});
    const scope = {sessionId: calls[0].receipt.executionSessionId!, taskId: calls[0].receipt.execution!.taskId};
    const open = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    const page = await f.runtime.commandBus.execute<ExecutionArtifactPage>(ArtifactCommand.List, scope);
    expect(page.items.length).toBeGreaterThan(0);
    const chunks = await Promise.all(page.items.map(item => f.runtime.commandBus.execute<ExecutionArtifactChunk>(ArtifactCommand.Read, {reference: item.reference})));
    expect(chunks.map(chunk => new TextDecoder().decode(chunk.data)).join(' ')).toContain(kind === 'agent' ? 'Done' : 'done');
    expect(open).not.toHaveBeenCalled();
    expect(await f.runtime.commandBus.execute(SessionCommand.GetCurrentId)).toBe(f.parent);
}, 15000);

it('projects a real pause request without treating the running model Effect as stopped', async () => {
    const f = await fixture(true), input = f.input('paused-child');
    const fetch = vi.fn((_url: unknown, options: {signal: AbortSignal}) => new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
    }));
    vi.stubGlobal('fetch', fetch);
    const receipt = await f.submit(input);
    let taskId = '';
    await vi.waitFor(async () => {taskId = (await f.inspect(input)).execution?.taskId ?? ''; expect(taskId).not.toBe(''); expect(fetch).toHaveBeenCalled();});
    const kernel = f.runtime.kernel.kernel;
    try {
        await kernel.controlTask(receipt.executionSessionId!, taskId, 'pause', {requestId: 'pause-observation', expectedEpoch: 0});
        const open = vi.spyOn(kernel, 'openSession');
        const calls = await f.runtime.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent});
        expect(calls[0].executionState).toMatchObject({id: taskId, controlEpoch: 1, control: {requested: 'pause'}, stopped: false, settled: false});
        expect(calls[0].executionState!.activeOperations).toBeGreaterThan(0);
        expect(calls[0].executionTree).toMatchObject({taskId, stopped: false, settled: false});
        expect(calls[0].executionTree!.activeOperations).toBeGreaterThan(0);
        expect(open).not.toHaveBeenCalled(); open.mockRestore();
    } finally {await (await (await kernel.openSession(receipt.executionSessionId!)).attachTask(taskId)).cancel();}
}, 15000);


async function controlQuery(f: Awaited<ReturnType<typeof fixture>>, input: IndependentCallInput, requestId = 'cancel-call') {
    let receipt: IndependentCallReceipt | undefined;
    await vi.waitFor(async () => {receipt = await f.inspect(input); expect(receipt.execution?.taskId).toBeTruthy();});
    return {sessionId: f.parent, branchId: 'main', callId: input.request.submission!.id,
        executionSessionId: receipt!.executionSessionId!, taskId: receipt!.execution!.taskId, requestId};
}

it.each(['agent', 'flow'] as const)('cancels only the routed independent %s and cold-reads its original admission', async kind => {
    const f = await fixture(kind === 'agent', true, true);
    if (kind === 'agent') vi.stubGlobal('fetch', vi.fn((_url: unknown, options: {signal: AbortSignal}) => new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
    })));
    const input = f.input('controlled-call', kind); await f.submit(input); const query = await controlQuery(f, input);
    const commands = f.runtime.commandBus, kernel = f.runtime.kernel.kernel;
    const result = await commands.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0});
    expect(result).toMatchObject({...query, receipt: {requestId: query.requestId, taskId: query.taskId, status: 'cancelled', expectedEpoch: 0}});
    expect(await commands.execute(SessionCommand.GetCurrentId)).toBe(f.parent);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.parent)).rounds).toEqual([]);
    const open = vi.spyOn(kernel, 'openSession');
    expect(await commands.execute(IndependentCallCommand.CancellationReceipt, query)).toEqual(result);
    expect(open).not.toHaveBeenCalled(); open.mockRestore();
    expect(await commands.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0})).toEqual(result);
    await expect(commands.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 1})).rejects.toMatchObject({code: 'CONFLICT'});
}, 15000);

it('rejects forged child, branch, root and call identities before dispatching any cancellation', async () => {
    const f = await fixture(false, true, true), input = f.input('scope-call', 'flow'); await f.submit(input);
    const query = await controlQuery(f, input), kernel = f.runtime.kernel.kernel;
    const cancel = vi.spyOn(kernel, 'cancel');
    for (const patch of [{executionSessionId: f.parent}, {branchId: 'other'}, {taskId: 'other-task'}, {callId: 'missing-call'}]) {
        await expect(f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, ...patch, expectedEpoch: 0})).rejects.toBeDefined();
        await expect(f.runtime.commandBus.execute(IndependentCallCommand.CancellationReceipt, {...query, ...patch})).rejects.toBeDefined();
    }
    expect(cancel).not.toHaveBeenCalled();
    expect(await kernel.readTaskCancellationReceipt(query.executionSessionId, query.taskId, query.requestId)).toBeUndefined();
    await f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0});
}, 15000);

it('keeps an already completed independent call successful when the user requests cancellation', async () => {
    const f = await fixture(), input = f.input('completed-cancel', 'flow'); await f.submit(input); const query = await controlQuery(f, input);
    const task = await (await f.runtime.kernel.kernel.openSession(query.executionSessionId)).attachTask(query.taskId);
    await task.wait({timeoutMs: 5000});
    const result = await f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0});
    expect(result).toMatchObject({receipt: {status: 'succeeded'}});
    expect((await task.status()).task.status).toBe('succeeded');
}, 15000);

it.each(['parent', 'child'] as const)('rejects independent cancellation when the %s Session becomes read-only', async denied => {
    const f = await fixture(false, true, true), input = f.input('readonly-call', 'flow'); await f.submit(input);
    const query = await controlQuery(f, input);
    let member = '';
    await vi.waitFor(async () => {member = (await f.runtime.kernel.kernel.listSessionPendingInteractionTasks(query.executionSessionId))[0]?.id ?? ''; expect(member).not.toBe('');});
    const answer = {...query, targetTaskId: member, interactionId: 'approval'};
    const check = f.runtime.sessionRepository.isSessionDeletionPending.bind(f.runtime.sessionRepository);
    const guard = vi.spyOn(f.runtime.sessionRepository, 'isSessionDeletionPending').mockImplementation(async id =>
        id === (denied === 'parent' ? query.sessionId : query.executionSessionId) || check(id));
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0})).rejects.toMatchObject({code: 'CALL_READ_ONLY'});
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, targetTaskId: member, expectedEpoch: 0})).rejects.toMatchObject({code: 'CALL_READ_ONLY'});
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.CancellationReceipt, {...query, targetTaskId: member})).toEqual({...query, targetTaskId: member});
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.Control, {...query, action: 'pause', expectedEpoch: 0})).rejects.toMatchObject({code: 'CALL_READ_ONLY'});
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.ControlReceipt, {...query, action: 'pause'})).toEqual({...query, action: 'pause'});
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.CancellationReceipt, query)).toEqual(query);
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.Respond, {...answer, value: 'saved'})).rejects.toMatchObject({code: 'CALL_READ_ONLY'});
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.ResponseReceipt, answer)).toEqual(answer);
    guard.mockRestore(); await f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0});
}, 15000);

it('recovers cancellation after its response is lost without dispatching cancellation again', async () => {
    const f = await fixture(false, true, true), input = f.input('lost-cancel', 'flow'); await f.submit(input);
    const query = await controlQuery(f, input), execute = f.runtime.commandBus.execute.bind(f.runtime.commandBus);
    const spy = vi.spyOn(f.runtime.commandBus, 'execute').mockImplementation(async (name, args) => {
        const result = await execute(name, args);
        if (name === IndependentCallCommand.Cancel) throw new Error('Cancellation reply lost');
        return result;
    });
    await expect(f.runtime.commandBus.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0})).rejects.toThrow('reply lost');
    const open = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    expect(await f.runtime.commandBus.execute(IndependentCallCommand.CancellationReceipt, query)).toMatchObject({receipt: {status: 'cancelled', expectedEpoch: 0}});
    expect(open).not.toHaveBeenCalled();
    expect(spy.mock.calls.filter(([name]) => name === IndependentCallCommand.Cancel)).toHaveLength(1);
}, 15000);

it('pauses an independent Flow at its boundary, saves an answer without resuming, and preserves original control receipts', async () => {
    const f = await fixture(false, true, true), input = f.input('pause-flow', 'flow'); await f.submit(input);
    const query = await controlQuery(f, input, 'pause-flow'), commands = f.runtime.commandBus, kernel = f.runtime.kernel.kernel;
    let member = '';
    await vi.waitFor(async () => {
        member = (await kernel.listSessionTasks(query.executionSessionId)).find(task => task.interactions.approval?.status === 'pending')?.id ?? '';
        expect(member).not.toBe('');
    });
    const views = await commands.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent});
    expect(views[0].interactions).toMatchObject({total: 1, items: [{taskId: member, interactionId: 'approval', kind: 'input'}]});
    const paused = await commands.execute<import('@itookit/llm-session/contracts').IndependentCallStateControlReceipt>(IndependentCallCommand.Control,
        {...query, action: 'pause', expectedEpoch: 0});
    expect(paused).toMatchObject({action: 'pause', receipt: {action: 'pause', accepted: {mode: 'pause', epoch: 1}}});
    await vi.waitFor(async () => expect((await kernel.task(query.executionSessionId, query.taskId)).control?.acknowledged).toBe(true));
    const child = await kernel.openSession(query.executionSessionId);
    const answer = {...query, targetTaskId: member, interactionId: 'approval', requestId: 'answer-flow'};
    expect(await commands.execute(IndependentCallCommand.Respond, {...answer, value: 'Continue later'}))
        .toMatchObject({...answer, receipt: {requestId: 'answer-flow', taskId: member, interactionId: 'approval'}});
    await expect(commands.execute(IndependentCallCommand.Respond, {...answer, value: 'Changed'})).rejects.toMatchObject({code: 'CONFLICT'});
    expect((await kernel.task(query.executionSessionId, query.taskId)).control?.mode).toBe('pause');
    expect((await kernel.task(query.executionSessionId, member)).interactions.approval.status).toBe('resolved');
    expect((await commands.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent}))[0].interactions).toEqual({total: 0, items: []});
    const resumed = await commands.execute(IndependentCallCommand.Control, {...query, action: 'resume', requestId: 'resume-flow', expectedEpoch: 1});
    expect(resumed).toMatchObject({action: 'resume', receipt: {action: 'run', accepted: {mode: 'run', epoch: 2}}});
    const exit = await (await child.attachTask(query.taskId)).wait({timeoutMs: 5000});
    expect(exit.status).toBe('succeeded'); expect(JSON.stringify(exit.output)).toContain('Continue later');
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(query.executionSessionId)).rounds[0]?.status).toBe('completed'));
    const open = vi.spyOn(kernel, 'openSession');
    expect(await commands.execute(IndependentCallCommand.ControlReceipt, {...query, action: 'pause'}))
        .toMatchObject({receipt: {action: 'pause', expectedEpoch: 0, accepted: {requestId: 'pause-flow', epoch: 1}, current: {mode: 'run', epoch: 2}}});
    expect(await commands.execute(IndependentCallCommand.ResponseReceipt, answer)).toMatchObject({receipt: {requestId: 'answer-flow'}});
    expect(open).not.toHaveBeenCalled();
    expect(await commands.execute(SessionCommand.GetCurrentId)).toBe(f.parent);
}, 15000);

it('withdraws only an unconfirmed independent Agent pause without aborting or restarting its model operation', async () => {
    const f = await fixture(true), input = f.input('pause-agent');
    const fetch = vi.fn((_url: unknown, options: {signal: AbortSignal}) => new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
    }));
    vi.stubGlobal('fetch', fetch); await f.submit(input); const query = await controlQuery(f, input, 'pause-agent');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const commands = f.runtime.commandBus, kernel = f.runtime.kernel.kernel;
    const before = await kernel.task(query.executionSessionId, query.taskId);
    try {
        expect(await commands.execute(IndependentCallCommand.Control, {...query, action: 'pause', expectedEpoch: 0}))
            .toMatchObject({receipt: {accepted: {mode: 'pause', acknowledged: false, epoch: 1}}});
        await expect(commands.execute(IndependentCallCommand.Control, {...query, action: 'resume', requestId: 'early-resume', expectedEpoch: 1}))
            .rejects.toMatchObject({code: 'CONTROL_NOT_SETTLED'});
        expect(await commands.execute(IndependentCallCommand.Control, {...query, action: 'withdraw', requestId: 'withdraw-agent', expectedEpoch: 1}))
            .toMatchObject({receipt: {action: 'withdraw-pause', accepted: {mode: 'run', epoch: 2}}});
        const after = await kernel.task(query.executionSessionId, query.taskId);
        expect(Object.values(after.effects).map(effect => effect.attemptCount)).toEqual(Object.values(before.effects).map(effect => effect.attemptCount));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect((fetch.mock.calls[0][1] as {signal: AbortSignal}).signal.aborted).toBe(false);
    } finally {await commands.execute(IndependentCallCommand.Cancel, {...query, requestId: 'end-agent', expectedEpoch: (await kernel.task(query.executionSessionId, query.taskId)).control?.epoch ?? 0});}
}, 15000);

it('rejects mismatched state-control scopes and refuses withdrawal after pause acknowledgement', async () => {
    const f = await fixture(false, true, true), input = f.input('state-scope', 'flow'); await f.submit(input);
    const query = await controlQuery(f, input, 'pause-once'), commands = f.runtime.commandBus, kernel = f.runtime.kernel.kernel;
    for (const change of [{taskId: 'other-task'}, {branchId: 'other'}, {executionSessionId: f.parent}, {action: 'inject'}])
        await expect(commands.execute(IndependentCallCommand.Control, {...query, action: 'pause', expectedEpoch: 0, ...change})).rejects.toBeDefined();
    expect(await commands.execute(IndependentCallCommand.ControlReceipt, {...query, action: 'pause'})).toEqual({...query, action: 'pause'});
    await commands.execute(IndependentCallCommand.Control, {...query, action: 'pause', expectedEpoch: 0});
    await expect(commands.execute(IndependentCallCommand.ControlReceipt, {...query, action: 'resume'})).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    await expect(commands.execute(IndependentCallCommand.Control, {...query, requestId: 'withdraw-confirmed', action: 'withdraw', expectedEpoch: 1})).rejects.toMatchObject({code: 'CONFLICT'});
    expect(await kernel.readTaskControlReceipt(query.executionSessionId, query.taskId, 'withdraw-confirmed')).toBeUndefined();
    await commands.execute(IndependentCallCommand.Cancel, {...query, requestId: 'end-scope', expectedEpoch: 1});
}, 15000);

it('cancels an explicitly scoped descendant after its Flow root completes and preserves both root and sibling', async () => {
    const f = await fixture(false, true, true), input = f.input('finished-parent', 'flow'); await f.submit(input);
    const rootQuery = await controlQuery(f, input), commands = f.runtime.commandBus, kernel = f.runtime.kernel.kernel;
    const session = await kernel.openSession(rootQuery.executionSessionId);
    const spec = {program: {kind: 'deferred-child', version: '1'}, input: null, deferStart: true};
    const child = await session.submit({...spec, parent: rootQuery.taskId}), sibling = await session.submit(spec);
    await child.pause({requestId: 'child-pause'});
    let member = '';
    await vi.waitFor(async () => {member = (await session.listTasks()).find(task => task.interactions.approval?.status === 'pending')?.id ?? ''; expect(member).not.toBe('');});
    await commands.execute(IndependentCallCommand.Respond, {...rootQuery, targetTaskId: member, interactionId: 'approval', requestId: 'finish-root', value: 'done'});
    await (await session.attachTask(rootQuery.taskId)).wait({timeoutMs: 5000});
    const before = await kernel.task(session.id, rootQuery.taskId), query = {...rootQuery, targetTaskId: child.id, requestId: 'cancel-child'};
    const views = await commands.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: f.parent});
    expect(views[0].descendants).toMatchObject({total: 1, items: [{taskId: child.id, parentTaskId: rootQuery.taskId, cancel: true, executionState: {controlEpoch: 1}}]});
    await expect(commands.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 0})).rejects.toMatchObject({code: 'CONFLICT'});
    expect(await commands.execute(IndependentCallCommand.CancellationReceipt, query)).toEqual(query);
    await expect(commands.execute(IndependentCallCommand.Cancel, {...query, targetTaskId: sibling.id, expectedEpoch: 0})).rejects.toMatchObject({code: 'CALL_CONTROL_SCOPE_MISMATCH'});
    const result = await commands.execute(IndependentCallCommand.Cancel, {...query, expectedEpoch: 1});
    expect(result).toMatchObject({...query, receipt: {taskId: child.id, status: 'cancelled', expectedEpoch: 1}});
    expect(await kernel.task(session.id, rootQuery.taskId)).toEqual(before);
    expect((await sibling.status()).task.status).toBe('created');
    const open = vi.spyOn(kernel, 'openSession');
    expect(await commands.execute(IndependentCallCommand.CancellationReceipt, query)).toEqual(result); expect(open).not.toHaveBeenCalled();
    expect(await kernel.readTaskCancellationReceipt(session.id, rootQuery.taskId, query.requestId)).toBeUndefined();
}, 15000);

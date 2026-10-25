import {ConversationContexts} from '../src/runtime/conversation-contexts';
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {IndependentCallCommand, SessionCommand, type IndependentCallInput, type IndependentCallReceipt, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function fixture(model = false, bind = true) {
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
        nodes: [{id: 'return', name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'done'}}],
        edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}}]});
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

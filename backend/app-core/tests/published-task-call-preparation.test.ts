import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {sha256Hex} from '@itookit/llm-context';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {IndependentCallCommand, SessionCommand, type IndependentCallInput, type IndependentCallReceipt, type IndependentCallView, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import type {AgentDefinition, HarnessConnectionSnapshot} from '@itookit/kernel-adapters/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const cleanup: Runtime[] = [];
afterEach(async () => {for (const runtime of cleanup.splice(0).reverse()) await runtime.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function fixture() {
    const backend = new MemoryBackend(), bodies: Array<{messages: unknown[]}> = [];
    await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture',
        baseURL: 'https://fixture.invalid', models: [{id: 'mock-model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'mock-model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body); bodies.push(body);
        if (body.stream) return new Response(`data: ${JSON.stringify({id: 'response', choices: [{index: 0,
            delta: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}});
        return new Response(JSON.stringify({id: 'response', choices: [{index: 0, message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}]}),
            {headers: {'content-type': 'application/json'}});
    }));
    const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false}); cleanup.push(runtime);
    const parent = await runtime.sessionRepository.createSession('Caller');
    const definition: AgentDefinition = {id: 'published-worker', name: 'Worker', type: 'agent',
        config: {systemPrompt: 'PUBLISHED_RULE'}};
    await publish(runtime, definition);
    return {runtime, parent, definition, bodies};
}
async function publish(runtime: Runtime, definition: AgentDefinition) {
    await runtime.agentService.saveAgent(definition);
    const state = await runtime.agentService.getAgentPublicationStatus(definition.id);
    return runtime.agentService.publishAgent({agentId: definition.id, operationId: `publish-${state.sourceDigest}`,
        expectedSourceDigest: state.sourceDigest, expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: state.latest?.target.version ?? null});
}
async function request(runtime: Runtime, parent: string, id = 'call', agentId = 'published-worker'): Promise<IndependentCallInput> {
    const catalog = await runtime.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const target = catalog.entries.find(entry => entry.target.kind === 'agent' && entry.target.id === agentId)!.target;
    return {title: 'Independent work', request: {expectedSessionId: parent, expectedBranch: 'main', expectedTarget: target,
        target: {kind: 'agent', id: target.id, version: target.version}, source: {kind: 'composer', text: 'PRIVATE REQUEST', values: {}, attachments: []},
        overrides: {executionMode: 'chat'}, submission: {id, source: {kind: 'conversation', ownerId: parent, id}}}};
}
async function childRequest(runtime: Runtime, parent: string) {
    const stored = await (await runtime.kernel.kernel.inspectSession(parent)).getShared('conversation/call/call');
    return (stored!.value as unknown as {childRequest: IndependentCallInput['request']}).childRequest;
}
it('prepares the real published target without a UI binding, queue, Round, model request or settings mutation', async () => {
    const {runtime, parent, bodies} = await fixture(), input = await request(runtime, parent);
    const before = runtime.sessionManager.getSnapshot();
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3, timeoutMs: null});
    expect(ready.plan.task.program).toEqual({kind: 'llm.chat', version: '2'});
    expect(JSON.stringify(ready.plan)).toContain('PUBLISHED_RULE'); expect(JSON.stringify(ready.plan)).toContain('PRIVATE REQUEST');
    expect(ready.context).toMatchObject({branchRef: 'main', branchHead: null, agent: {id: 'published-worker', version: input.request.expectedTarget!.version}});
    expect(runtime.sessionManager.getSnapshot()).toEqual(before);
    expect(await runtime.sessionRepository.readHistoryChain(ready.executionSessionId)).toMatchObject({rounds: []});
    expect(await runtime.kernel.kernel.listSessionTasks(parent)).toEqual([]); expect(await runtime.kernel.kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
    expect((await runtime.sessionRepository.getSessionSettings(ready.executionSessionId)).executionModeLocked).not.toBe(true);
    expect(bodies).toEqual([]);
});
it('dispatches and replays the real prepared published call through the configured host service', async () => {
    const {runtime, parent, bodies} = await fixture(), input = await request(runtime, parent);
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3, timeoutMs: null});
    const first = await runtime.independentCalls!.submitPreparedTaskCall(input);
    const caller = await runtime.kernel.kernel.attachTask(parent, first.submission.task.taskId);
    expect(await caller.wait({until: 'settled', timeoutMs: 5000})).toMatchObject({status: 'succeeded', output: {task: {sessionId: ready.executionSessionId}}});
    expect(await runtime.independentCalls!.submitPreparedTaskCall(input)).toEqual(first);
    expect(bodies).toHaveLength(1); expect(await runtime.kernel.kernel.listSessionTasks(ready.executionSessionId)).toHaveLength(1);
});
it('keeps the frozen publication after draft edits and only prepares a new publication for a new request', async () => {
    const {runtime, parent, definition} = await fixture(), input = await request(runtime, parent);
    const first = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3});
    await publish(runtime, {...definition, config: {...definition.config, systemPrompt: 'NEW_PUBLISHED_RULE'}});
    expect(await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3})).toEqual(first);
    const next = await runtime.independentCalls!.prepareTaskCall(await request(runtime, parent, 'next'), {maxDepth: 3});
    expect(next.plan.task.labels?.targetVersion).not.toBe(first.plan.task.labels?.targetVersion);
    expect(JSON.stringify(next.plan)).toContain('NEW_PUBLISHED_RULE'); expect(JSON.stringify(first.plan)).not.toContain('NEW_PUBLISHED_RULE');
});
it('materializes authorized frozen child attachments through the shared conversation context builder', async () => {
    const {runtime, parent} = await fixture(), input = await request(runtime, parent), bytes = new TextEncoder().encode('PRIVATE FILE CONTENT');
    await runtime.sessionRepository.writeAttachment(parent, 'note.txt', bytes.buffer);
    input.request.attachments = [{name: 'note.txt', type: 'text/plain', size: bytes.byteLength, content: {sha256: await sha256Hex(bytes), bytes: bytes.byteLength}}];
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3});
    expect(JSON.stringify(ready.plan)).toContain('PRIVATE FILE CONTENT');
    expect(await runtime.sessionRepository.listHistory(ready.executionSessionId)).toEqual([]);
});
it.each(['owner', 'branch', 'head'] as const)('rejects a changed child %s before preparing an unrelated context', async change => {
    const {runtime, parent} = await fixture(), input = await request(runtime, parent);
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3}), child = await childRequest(runtime, parent);
    if (change === 'owner') child.submission!.source.ownerId = 'foreign';
    if (change === 'branch') child.expectedBranch = 'foreign';
    if (change === 'head') await runtime.sessionRepository.updateManifest(ready.executionSessionId, {branches: {main: 'other'}, currentHead: 'other'});
    await expect(runtime.sessionManager.prepareIndependentTaskCall(child, ready.invocation)).rejects.toHaveProperty('code', 'CALL_PREPARATION_SCOPE_MISMATCH');
});
it('refuses structured arguments for an ordinary published Agent without silently discarding them', async () => {
    const {runtime, parent, bodies} = await fixture(), input = await request(runtime, parent);
    input.request.source = {kind: 'arguments', value: {request: 'PRIVATE ARGUMENT'}};
    await expect(runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3})).rejects.toHaveProperty('code', 'CALL_INPUT_UNBOUND');
    expect(bodies).toEqual([]); expect(await runtime.independentCalls!.inspectPreparedTaskCall(input)).toBeUndefined();
});
it('prepares a published Harness Agent through its actual connection resolver without invoking a native turn', async () => {
    const {runtime, parent, bodies} = await fixture();
    const connection: HarnessConnectionSnapshot = {version: 1, revision: 1, id: 'remote', name: 'Remote', kind: 'harness', nodeConnectionId: 'node',
        projectId: 'project', profileId: 'codex', project: {root: '/workspace'}};
    runtime.agentService.configureHarnessConnections(async () => connection);
    await publish(runtime, {id: 'native-worker', name: 'Native', type: 'agent', execution: {kind: 'harness', connectionId: 'remote'}, config: {systemPrompt: 'Native rule'}});
    const ready = await runtime.independentCalls!.prepareTaskCall(await request(runtime, parent, 'native', 'native-worker'), {maxDepth: 3});
    expect(ready.plan.task.program).toEqual({kind: 'kernel-adapters.harness', version: '1'});
    expect(ready.plan.task.input).toMatchObject({connection, context: {invocationId: ready.invocation.invocationId}});
    expect(bodies).toEqual([]); expect(await runtime.kernel.kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
});
it('prepares an explicit Agent loop using the host tool catalog and policy without locking Session preferences', async () => {
    const {runtime, parent, bodies} = await fixture(), input = await request(runtime, parent);
    input.request.overrides!.executionMode = 'agent';
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3});
    expect(ready.plan.task.program.kind).toBe('llm.agent');
    expect(ready.plan.task.input).toMatchObject({maxExchanges: expect.any(Number), allowedToolIds: expect.any(Array)});
    expect((await runtime.sessionRepository.getSessionSettings(ready.executionSessionId)).executionModeLocked).not.toBe(true);
    expect(bodies).toEqual([]);
});
it('rejects an unpublished legacy target instead of treating it as a published implementation', async () => {
    const {runtime, parent} = await fixture();
    await runtime.agentService.saveAgent({id: 'legacy', name: 'Legacy', type: 'agent', config: {systemPrompt: 'Legacy'}});
    const input = await request(runtime, parent, 'legacy', 'legacy');
    await expect(runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3})).rejects.toHaveProperty('code', 'CALL_PUBLISHED_TARGET_REQUIRED');
    expect(await runtime.independentCalls!.inspectPreparedTaskCall(input)).toBeUndefined();
});
it('rechecks child write permission after asynchronous publication resolution', async () => {
    const {runtime, parent, bodies} = await fixture(), input = await request(runtime, parent);
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3}), child = await childRequest(runtime, parent);
    let denied = false;
    vi.spyOn(runtime.sessionRepository, 'isSessionDeletionPending').mockImplementation(async id => denied && id === ready.executionSessionId);
    const original = runtime.agentService.getAgentRevision.bind(runtime.agentService);
    vi.spyOn(runtime.agentService, 'getAgentRevision').mockImplementationOnce(async (...args) => {const revision = await original(...args); denied = true; return revision;});
    await expect(runtime.sessionManager.prepareIndependentTaskCall(child, ready.invocation)).rejects.toHaveProperty('code', 'CALL_READ_ONLY');
    expect(bodies).toEqual([]); expect(await runtime.kernel.kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
});
it('enforces local exposure even when the caller supplies an exact published identity', async () => {
    const {runtime, parent, definition} = await fixture(), input = await request(runtime, parent);
    const local = await publish(runtime, {...definition, id: 'private', exposure: 'local'});
    input.request.expectedTarget = local.target; input.request.target = {kind: 'agent', id: local.target.id, version: local.target.version};
    await expect(runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3})).rejects.toHaveProperty('code', 'CALLABLE_LOCAL_ONLY');
});
it('prepares a published Flow implementation as an aggregate with its graph and workspace lifecycle', async () => {
    const {runtime, parent, definition} = await fixture();
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [{id: 'implementation', name: 'Implementation', draftVersion: 1, updatedAt: 0,
        layout: {}, nodes: [{id: 'value', name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'Done'}}], edges: []}]});
    await publish(runtime, {...definition, execution: {kind: 'flow', flowId: 'implementation', revision: 1}});
    const input = await request(runtime, parent);
    await expect(runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3})).rejects.toHaveProperty('code', 'FLOW_INPUT_UNBOUND');
    expect(await runtime.independentCalls!.inspectPreparedTaskCall(input)).toBeUndefined();
    const corrected = await request(runtime, parent, 'bound-flow');
    corrected.request.source = {kind: 'arguments', value: {}};
    const ready = await runtime.independentCalls!.prepareTaskCall(corrected, {maxDepth: 3});
    expect(ready.plan.task).toMatchObject({program: {kind: 'flow.aggregate', version: '1'},
        labels: {kind: 'flow-root', invocationId: ready.invocation.invocationId},
        input: {initialWorkspacePending: 1, initialWorkspaceResource: 1, initialScheduler: expect.any(Object)}});
    expect(await runtime.independentCalls!.inspectPreparedTaskCall(corrected)).toEqual(ready);
    expect(await runtime.kernel.kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
    expect(await runtime.sessionRepository.listHistory(ready.executionSessionId)).toEqual([]);
});
it('reports actual Kernel acceptance and target through the existing call commands before history is written', async () => {
    const {runtime, parent} = await fixture(), input = await request(runtime, parent);
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3});
    const admitted = await runtime.independentCalls!.submitPreparedTaskCall(input);
    await (await runtime.kernel.kernel.attachTask(parent, admitted.submission.task.taskId)).wait({until: 'settled', timeoutMs: 5000});
    const receipt = await runtime.commandBus.execute<IndependentCallReceipt>(IndependentCallCommand.Inspect, input);
    expect(receipt).toMatchObject({status: 'accepted', evidence: 'kernel', callerExecution: admitted.submission.task,
        executionSessionId: ready.executionSessionId});
    expect(receipt.execution).toBeUndefined();
    const [view] = await runtime.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: parent});
    expect(view.receipt.execution).toMatchObject({role: 'primary', invocation: ready.invocation});
    expect(view).toMatchObject({historyPending: true, callerState: {phase: 'done', exitStatus: 'succeeded'}, executionState: {phase: 'done', exitStatus: 'succeeded'}});
    expect(view.status).toBeUndefined(); expect(await runtime.sessionRepository.listHistory(ready.executionSessionId)).toEqual([]);
});
it('reconciles a lost caller response with the existing inspect command without inventing a target', async () => {
    const {runtime, parent, bodies} = await fixture(), input = await request(runtime, parent);
    const ready = await runtime.independentCalls!.prepareTaskCall(input, {maxDepth: 3}), kernel = runtime.kernel.kernel, original = kernel.submit.bind(kernel);
    vi.spyOn(kernel, 'submit').mockImplementationOnce(async (...args) => {await original(...args); throw Object.assign(Error('Reply lost'), {code: 'ETIMEDOUT'});});
    await expect(runtime.independentCalls!.submitPreparedTaskCall(input)).rejects.toHaveProperty('code', 'ETIMEDOUT');
    const receipt = await runtime.commandBus.execute<IndependentCallReceipt>(IndependentCallCommand.Inspect, input);
    expect(receipt).toMatchObject({status: 'accepted', evidence: 'kernel', executionSessionId: ready.executionSessionId});
    expect(receipt.execution).toBeUndefined(); expect(receipt.callerExecution).toBeDefined();
    expect(await kernel.listSessionTasks(ready.executionSessionId)).toEqual([]); expect(bodies).toEqual([]);
});

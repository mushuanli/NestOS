import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Kernel} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend, type IVFSManager} from '@itookit/vfs-core';
import {sha256HexSync, type ContextSnapshot} from '@itookit/llm-context';
import {registerDurablePrograms, submitRun, submitTaskCall} from '@itookit/llm-flow';
import {invocationLabels, targetLabels} from '@itookit/llm-flow/contracts';
import {HarnessProgram, HarnessExecutionEffect} from '@itookit/kernel-adapters';
import {prepareDirectRun, type DirectRunPreparation, type DirectConversationInput} from '../src';
import {directTaskSpec} from '../src/session/direct-conversation';
import {snapshotDirectAgentPolicy} from '../src/contracts/direct-agent-policy';
import {t} from '../src/utils/host-ports';

let kernel: Kernel, manager: IVFSManager;
const model = vi.fn(async () => ({choices: [{message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}]}));
const native = vi.fn(async () => ({text: 'Native done', sessionId: 'native-session', turnId: 'native-turn'}));
const connection = {version: 1 as const, revision: 1, id: 'remote', name: 'Remote', kind: 'harness' as const,
    nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: {root: '/workspace'}};
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); const fs = await manager.openFileSystem('/');
    kernel = new Kernel({catalog: {fs}, maxConcurrentEffects: 1});
    kernel.registerStorageResolver({kind: 'test', resolve: async ref => ({fs, rootPath: String(ref.locator)})});
    registerDurablePrograms(kernel); kernel.registerProgram(new HarnessProgram());
    kernel.registerEffect({kind: 'llm.chat', version: '1', execute: model});
    kernel.registerEffect(new HarnessExecutionEffect({execute: native, cancel: async (_request, context) => ({status: 'stopped', cleanup: 'confirmed',
        evidence: {sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'terminal'}}),
        reconcile: async (_request, context) => ({status: 'not-started', evidence: {sessionId: context.sessionId,
            taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'not-started'}})}));
    await kernel.initialize();
    for (const id of ['source', 'target']) await kernel.createSession({id, storage: {kind: 'test', locator: `/${id}`}});
    model.mockClear(); native.mockClear();
});
afterEach(async () => {vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await manager.dispose();});
function preparation(): DirectRunPreparation {
    const execution: DirectConversationInput = {roundId: 'round', task: {sessionId: 'target', input: {sessionId: 'target',
        text: 'Hello', files: [], agentId: 'reviewer', invocation: {invocationId: 'callee'}, overrides: {executionMode: 'chat'}}},
        config: {id: 'reviewer', name: 'Reviewer', type: 'agent', connectionId: 'model', stream: false,
            target: {kind: 'agent', id: 'reviewer', version: '1', digest: 'a'.repeat(64)}, capabilityPolicy: {toolIds: ['inspect'], mcpProfileIds: []}}};
    const snapshot: ContextSnapshot = {id: 'context', taskRunId: 'run', createdAt: 1, branchRef: 'main', branchHead: null,
        profile: {id: 'profile', revision: 1}, agent: {id: 'reviewer', version: '1'}, blocks: [],
        canonicalMessages: [{role: 'system', content: 'Assembled policy'}, {role: 'user', content: 'Hello'}], tokenCount: 4, digest: 'b'.repeat(64)};
    snapshot.digest = sha256HexSync(JSON.stringify(snapshot.canonicalMessages));
    return {execution, snapshot, catalog: {definitions: [{name: 'inspect', description: 'Inspect'}], externalIds: ['inspect']},
        hasProgram: (kind, version) => kernel.programs.has(kind, version), translate: t};
}
it('prepares detached data without a UI state, execution controller, Task admission or model request', async () => {
    const input = preparation(); input.execution.task.input.overrides!.executionMode = 'agent'; input.policy = {maxExchanges: 3};
    const prepared = prepareDirectRun(input), serialized = JSON.stringify(prepared);
    input.snapshot.canonicalMessages[1].content = 'Changed'; input.catalog.definitions[0].name = 'outside';
    input.execution.config.capabilityPolicy!.toolIds!.push('outside'); input.policy.maxExchanges = 99;
    expect(JSON.stringify(prepared)).toBe(serialized);
    expect(prepared.task.input).toMatchObject({maxExchanges: 3, allowedToolIds: ['inspect'], messages: [{content: 'Assembled policy'}, {content: 'Hello'}]});
    expect(await kernel.listSessionTasks('target')).toEqual([]); expect(model).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
});
it('replays an existing deferred direct Task using the exact legacy submission fingerprint', async () => {
    const input = preparation(), {execution, snapshot, catalog} = input;
    const legacy = directTaskSpec(execution, snapshot, catalog, [], snapshotDirectAgentPolicy());
    legacy.labels = {...legacy.labels, ...invocationLabels(execution.task.input.invocation), ...targetLabels(execution.config.target)};
    legacy.requestId = 'invocation:callee';
    const previous = await kernel.submit('target', {...legacy, deferStart: true});
    const run = await submitRun(prepareDirectRun(input), {kernel});
    expect(run.root.id).toBe(previous.id); expect((await run.root.wait({timeoutMs: 3000})).status).toBe('succeeded');
    expect(await kernel.listSessionTasks('target')).toHaveLength(1); expect(model).toHaveBeenCalledOnce();
});
it.each(['chat', 'agent', 'harness'] as const)('hands a prepared %s definition to the same cross-Session Kernel call path', async kind => {
    const input = preparation();
    if (kind === 'agent') input.execution.task.input.overrides!.executionMode = 'agent';
    if (kind === 'harness') {
        input.execution.config.execution = {kind: 'harness', connectionId: 'remote'};
        input.execution.config.harnessConnection = structuredClone(connection);
    }
    const prepared = prepareDirectRun(input), restored = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
    const run = await submitTaskCall(restored, {kernel, caller: {sessionId: 'source', requestId: `${kind}-call`}, maxDepth: 3});
    const text = kind === 'harness' ? 'Native done' : 'Done';
    const exit = await run.root.wait({until: 'settled', timeoutMs: 3000}); expect(exit.error?.message).toBeUndefined();
    expect(exit).toMatchObject({status: 'succeeded',
        output: {task: {sessionId: 'target'}, exit: {output: {message: {content: text}}}}});
    const target = (await kernel.listSessionTasks('target'))[0];
    expect(target.ownedBy).toMatchObject({sessionId: 'source', taskId: run.root.id});
    expect(target.labels).toMatchObject({invocationId: 'callee', roundId: 'round', targetId: 'reviewer'});
    expect(prepared.capabilities.map(binding => binding.kind)).toEqual(kind === 'harness' ? ['harness'] : kind === 'agent' ? ['llm', 'tool'] : ['llm']);
});
it('keeps context assembly authoritative and never appends host policy to prepared messages again', () => {
    const input = preparation(); input.policy = {systemPrompt: ['Assembled policy']};
    const result = prepareDirectRun(input);
    expect((result.task.input as {messages: unknown[]}).messages).toEqual(input.snapshot.canonicalMessages);
});
it('freezes program version selection and rejects Flow input before it can become an unmanaged aggregate', () => {
    const input = preparation(); input.hasProgram = (_kind, version) => version === '2';
    expect(prepareDirectRun(input).task.program.version).toBe('2');
    input.execution.config.type = 'flow';
    expect(() => prepareDirectRun(input)).toThrow(expect.objectContaining({code: 'CALL_GRAPH_PREPARATION_REQUIRED'}));
});
it('rejects an explicit tool-less Agent and an invalid host exchange policy before admission', async () => {
    const input = preparation(); input.execution.task.input.overrides!.executionMode = 'agent'; input.execution.config.capabilityPolicy!.toolIds = [];
    expect(() => prepareDirectRun(input)).toThrow(expect.objectContaining({code: 'AGENT_TOOLS_UNAVAILABLE'}));
    input.execution.task.input.overrides!.executionMode = 'chat'; input.policy = {maxExchanges: 0};
    expect(() => prepareDirectRun(input)).toThrow('positive safe integer');
    expect(await kernel.listSessionTasks('target')).toEqual([]);
});

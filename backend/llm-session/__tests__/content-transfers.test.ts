import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Kernel, KernelErrorCode } from '@itookit/durable-kernel';
import { DagCommandService, createBuiltinDagPluginRegistry, registerDurablePrograms, type FlowDefinitionStore, type FlowRevision } from '@itookit/llm-flow';
import { CommandBus } from '../src/core/command-bus';
import { SessionRepository } from '../src/persistence/session-repository';
import { RoundLog } from '../src/persistence/round-log';
import { sessionDirectoryStorage, SessionDirectoryStorageResolver } from '../src/persistence/session-directory-storage';
import { ContentTransferService } from '../src/session/content-transfers';
import { FlowInvocationService } from '../src/session/flow-invocations';
import { ContentTransferCommand, type ContentCapture, type ContentTransfer, type Round } from '../src/contracts';
import { ConversationContextBuilder } from '../src/session/conversation-context';
import { snapshotDirectAgentPolicy } from '../src/contracts/direct-agent-policy';
import { ContextAssembler, type ContextPlan } from '@itookit/llm-context';

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, repository: SessionRepository;
let commands: CommandBus, service: ContentTransferService, sessionId: string, log: RoundLog;
const summarize = vi.fn(async () => 'A frozen summary'), logger = {info: vi.fn(), error: vi.fn()};
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()}));
    const fs = await manager.openFileSystem('/');
    kernel = new Kernel({catalog: {fs}, pollMs: 5}); kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
    registerDurablePrograms(kernel); await kernel.initialize();
    repository = new SessionRepository(fs, async id => { await kernel.createSession({id, storage: sessionDirectoryStorage(id)}); });
    await repository.init(); sessionId = await repository.createSession('Parent');
    commands = new CommandBus(); commands.register('session.flow.invocations', async () => []);
    service = new ContentTransferService({kernel, repository, commands, summarize, hostPorts: {logger: logger as never}}); service.register();
    log = new RoundLog(repository, sessionId); await append('r1', 'first question', 'first reply');
});
afterEach(async () => {
    vi.restoreAllMocks(); summarize.mockReset().mockResolvedValue('A frozen summary'); logger.info.mockClear(); logger.error.mockClear();
    for await (const session of kernel.listSessions()) await kernel.closeSession(session.id, true);
    kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
});
async function append(id: string, question: string, answer: string, status: Round['status'] = 'completed'): Promise<void> {
    const manifest = await log.loadManifest();
    await log.append('main', {id, sessionId, input: [{role: 'user', content: question}], output: [{role: 'assistant', content: answer}],
        historyParentIds: manifest.currentHead ? [manifest.currentHead] : [], status, executions: [], origin: 'user', createdAt: Date.now()});
}
const capture = () => commands.execute<ContentCapture>(ContentTransferCommand.Capture, {sessionId});
const resolve = (captureId: string, selection: ContentTransfer['selection']) => commands.execute<ContentTransfer>(ContentTransferCommand.Resolve, {sessionId, captureId, selection});

it('freezes complete messages, distinguishes replies from conversation, and never includes partial assistant output', async () => {
    const source = await capture(); await append('r2', 'new question', 'unfinished reply', 'running');
    expect((await resolve(source.id, {kind: 'latest'})).value).toBe('first reply');
    expect((await resolve(source.id, {kind: 'conversation'})).value).toContain('first question');
    expect((await resolve(source.id, {kind: 'replies'})).value).not.toContain('first question');
    const fresh = await capture();
    expect(fresh.messages.some(message => message.text === 'unfinished reply')).toBe(false);
    const selected = await resolve(source.id, {kind: 'selected', messageIds: [source.messages[0].id]});
    expect(selected.value).toBe('first question'); expect(selected.head).toBe('r1');
    await expect(resolve(source.id, {kind: 'selected', messageIds: ['not-in-snapshot']})).rejects.toThrow('CONTENT_SELECTION_INVALID');
});

it('persists prepared summaries and emits only safe correlation metadata on failure', async () => {
    const source = await capture(), summary = await resolve(source.id, {kind: 'summary'});
    expect(summary.value).toBe('A frozen summary'); expect(summarize).toHaveBeenCalledWith(sessionId, expect.stringContaining('first question'));
    summarize.mockRejectedValueOnce(new Error('provider failure containing sensitive message'));
    await expect(resolve(source.id, {kind: 'summary'})).rejects.toThrow('provider failure');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sensitive message');
    expect(logger.error).toHaveBeenCalledWith('Content transfer', expect.objectContaining({stage: 'resolve', outcome: 'failure', operationId: expect.any(String)}));
    const restored = new ContentTransferService({kernel, repository, commands});
    expect(await restored.read({sessionId, id: summary.id}, sessionId)).toEqual(summary);
});

it('creates one child after a lost receipt and keeps its frozen material independent and immutable', async () => {
    const source = await capture(), transfer = await resolve(source.id, {kind: 'latest'});
    const input = {sessionId, requestId: 'child-request', title: 'Review', transfer: {sessionId, id: transfer.id}};
    const created = await service.createChild(input), replayed = await new ContentTransferService({kernel, repository, commands}).createChild(input);
    expect(replayed).toEqual(created); expect(await repository.list()).toHaveLength(2);
    await append('r2', 'later', 'changed parent');
    const child = await repository.getManifest(created.sessionId);
    expect(child.parentSessionId).toBe(sessionId); expect(child.initialContext?.value).toBe('first reply');
    expect(await repository.listHistory(created.sessionId)).toEqual([]);
    await expect(repository.updateManifest(created.sessionId, {initialContext: {...transfer, value: 'changed'}})).rejects.toThrow('immutable');
    await expect(service.createChild({...input, title: 'Other'})).rejects.toThrow('CONTENT_CHILD_REQUEST_CONFLICT');
});

it('includes the child material in context planning without adding a fake Round', async () => {
    const source = await capture(), transfer = await resolve(source.id, {kind: 'summary'});
    const child = await service.createChild({sessionId, requestId: 'context-child', title: 'Independent', transfer: {sessionId, id: transfer.id}});
    const assemble = vi.spyOn(ContextAssembler.prototype, 'assemble').mockResolvedValue({snapshot: {} as never, messages: []});
    const builder = new ConversationContextBuilder({engine: repository, loadArtifact: async () => null}, snapshotDirectAgentPolicy());
    await builder.assemble({task: {id: 'task', sessionId: child.sessionId, input: {text: 'Follow up'}}, config: {id: 'agent'},
        roundId: 'child-round', contextFiles: [], log: new RoundLog(repository, child.sessionId)} as never, {branchRef: 'main', branchHead: null});
    const plan = assemble.mock.calls[0][0] as ContextPlan;
    expect(plan.explicitInputs).toEqual([expect.objectContaining({kind: 'text', content: 'A frozen summary'})]);
    expect(await repository.listHistory(child.sessionId)).toEqual([]);
});

it('validates bound parameter values before starting a Flow and retains validated provenance on replay', async () => {
    const source = await capture(), transfer = await resolve(source.id, {kind: 'latest'});
    const flow: FlowRevision = {id: 'f' as never, name: 'F', revision: 1, digest: 'f', createdAt: 0,
        parameters: [{name: 'text', type: 'string', required: true}], nodes: [], edges: []};
    const definitions = {loadRevision: async () => flow} as unknown as FlowDefinitionStore;
    const dag = new DagCommandService({kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: definitions}); dag.register(commands);
    const invocations = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, undefined, undefined, dag, service);
    const input = {sessionId, requestId: 'bound-call', flowId: 'f', revision: 1, parameters: {text: 'tampered'}, inputSources: {text: {sessionId, id: transfer.id}}};
    await expect(invocations.invoke(input)).rejects.toThrow('CONTENT_PARAMETER_MISMATCH');
    expect(await kernel.listSessionTasks(sessionId)).toEqual([]);
    input.parameters.text = 'first reply'; const call = await invocations.invoke(input);
    expect(call.inputTransfers?.text).toEqual(transfer);
    expect((await invocations.invoke(input)).rootTaskId).toBe(call.rootTaskId);
    await expect(invocations.invoke({...input, inputSources: {}})).rejects.toThrow('different arguments');
});

it('rejects cross-session reads and write-lease failures', async () => {
    const source = await capture(), transfer = await resolve(source.id, {kind: 'latest'}), other = await repository.createSession('Other');
    await expect(service.read({sessionId, id: transfer.id}, other)).rejects.toThrow('CONTENT_SOURCE_OUTSIDE_SESSION');
    const denied = new ContentTransferService({kernel, repository, commands, canWrite: async () => false});
    await expect(denied.capture(sessionId)).rejects.toThrow('CONTENT_SESSION_READ_ONLY');
});

it('prepares child execution before navigation even when repository creation only initializes metadata', async () => {
    const raw = new SessionRepository(await manager.openFileSystem('/')); await raw.init();
    const service = new ContentTransferService({kernel, repository: raw, commands});
    const created = await service.createChild({sessionId, requestId: 'metadata-only-child', title: 'Background flow'});
    expect((await kernel.sessionStat(created.sessionId)).phase).toBe('open');
    const source = await capture(), transfer = await resolve(source.id, {kind: 'latest'});
    expect(await service.read({sessionId, id: transfer.id}, created.sessionId)).toEqual(transfer);
    await raw.dispose();
});

it('freezes a named structured Flow output and preserves the concrete run and output port', async () => {
    const catalog = new CommandBus(); let score = 7;
    catalog.register('session.flow.invocations', async () => [{requestId: 'review-call', rootTaskId: 'review-root', flow: {name: 'Review'}}]);
    catalog.register('dag.run.get', async () => ({root: {task: {status: 'succeeded', output: {nodes: {__flow_return: {report: {score}}}}}}}));
    const service = new ContentTransferService({kernel, repository, commands: catalog});
    const capture = await service.capture(sessionId); score = 99;
    const transfer = await service.resolve({sessionId, captureId: capture.id, selection: {kind: 'output', outputId: 'review-call/report'}});
    expect(transfer.value).toEqual({score: 7});
    expect(transfer.output).toMatchObject({taskId: 'review-root', requestId: 'review-call', port: 'report'});
    await expect(service.resolve({sessionId, captureId: capture.id, selection: {kind: 'unknown'} as never})).rejects.toThrow('CONTENT_SELECTION_INVALID');
});

it('prepares child storage before the recovery gate and retries a refused lease with the same child identity', async () => {
    const raw = new SessionRepository(await manager.openFileSystem('/')); await raw.init();
    const stages: string[] = [], children: string[] = [];
    const prepareExecution = vi.fn(async (id: string) => {
        stages.push('prepare'); children.push(id);
        if (children.length === 1) throw Object.assign(new Error('Lease refused'), {code: 'SESSION_EXECUTION_READ_ONLY'});
        await kernel.createSession({id, storage: sessionDirectoryStorage(id)});
    });
    const canWrite = vi.fn(async (id: string) => {
        if (id === sessionId) return true;
        stages.push('recovery');
        return (await kernel.sessionStat(id)).phase === 'open';
    });
    const transfer = new ContentTransferService({kernel, repository: raw, commands, prepareExecution, canWrite});
    const input = {sessionId, requestId: 'lease-child', title: 'Prepared child'};
    try {
        await expect(transfer.createChild(input)).rejects.toMatchObject({code: 'SESSION_EXECUTION_READ_ONLY'});
        expect(stages).toEqual(['prepare']);
        await expect(kernel.openSession(children[0])).rejects.toMatchObject({code: KernelErrorCode.SESSION_NOT_FOUND});
        const child = await transfer.createChild(input);
        expect(children).toEqual([child.sessionId, child.sessionId]);
        expect(stages).toEqual(['prepare', 'prepare', 'recovery']);
        expect(await raw.list()).toHaveLength(2);
    } finally {await raw.dispose();}
});


it('freezes a waiting duplicate before caller mutation', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(done => {release = done;});
    const local = new ContentTransferService({kernel, repository, commands, prepareExecution: () => blocked});
    const input = {sessionId, requestId: 'frozen-duplicate', title: 'Independent'};
    const first = local.createChild(input);
    const duplicate = local.createChild({...input});
    const changed = {...input}; const waiting = local.createChild(changed);
    changed.title = 'Changed after submission'; release();
    expect(await waiting).toEqual(await first); expect(await duplicate).toEqual(await first);
});

it('reconciles a persisted child intent when its write reply is lost', async () => {
    const originalOpen = kernel.openSession.bind(kernel);
    const handle = await kernel.openSession(sessionId), original = handle.setShared.bind(handle);
    let lost = false;
    vi.spyOn(handle, 'setShared').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!lost && args[0] === 'content.child.lost-intent') {lost = true; throw new Error('Lost write reply');}
        return result;
    });
    vi.spyOn(kernel, 'openSession').mockImplementation(async id => id === sessionId ? handle : originalOpen(id));
    const input = {sessionId, requestId: 'lost-intent', title: 'Independent'};
    const created = await service.createChild(input);
    expect(lost).toBe(true);
    expect(await new ContentTransferService({kernel, repository, commands}).createChild(input)).toEqual(created);
});

it('accepts equivalent child request field ordering without changing its identity', async () => {
    const created = await service.createChild({sessionId, requestId: 'same-fields', title: 'Independent'});
    expect(await service.createChild({title: 'Independent', requestId: 'same-fields', sessionId})).toEqual(created);
});


it.each([false, true])('reconciles concurrent child creators and rejects a different frozen request (%s)', async conflict => {
    const originalOpen = kernel.openSession.bind(kernel), handle = await kernel.openSession(sessionId);
    const originalRead = handle.getShared.bind(handle); let readers = 0, release!: () => void;
    const barrier = new Promise<void>(done => {release = done;});
    vi.spyOn(handle, 'getShared').mockImplementation(async key => {
        const result = await originalRead(key);
        if (key === 'content.child.concurrent' && ++readers <= 2) {if (readers === 2) release(); await barrier;}
        return result;
    });
    vi.spyOn(kernel, 'openSession').mockImplementation(async id => id === sessionId ? handle : originalOpen(id));
    const other = new ContentTransferService({kernel, repository, commands});
    const input = {sessionId, requestId: 'concurrent', title: 'Independent'};
    const outcomes = await Promise.allSettled([service.createChild(input), other.createChild({...input, title: conflict ? 'Different' : input.title})]);
    const accepted = outcomes.filter(result => result.status === 'fulfilled');
    expect(accepted, outcomes.map(result => result.status === 'rejected' ? String(result.reason) : 'accepted').join(', ')).toHaveLength(conflict ? 1 : 2);
    if (conflict) expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({reason: {message: 'CONTENT_CHILD_REQUEST_CONFLICT'}});
    else expect(accepted[0]).toEqual(accepted[1]);
    const stored = (await originalRead('content.child.concurrent'))!.value as unknown as {sessionId: string};
    expect(await repository.getManifest(stored.sessionId)).toMatchObject({parentSessionId: sessionId});
});


it('does not manufacture a child when intent persistence fails without evidence', async () => {
    const originalOpen = kernel.openSession.bind(kernel), handle = await kernel.openSession(sessionId);
    vi.spyOn(handle, 'setShared').mockRejectedValueOnce(new Error('Storage unavailable'));
    vi.spyOn(kernel, 'openSession').mockImplementation(async id => id === sessionId ? handle : originalOpen(id));
    const ensure = vi.spyOn(repository, 'ensureSession');
    await expect(service.createChild({sessionId, requestId: 'failed-intent', title: 'Independent'})).rejects.toThrow('Storage unavailable');
    expect(ensure).not.toHaveBeenCalled();
    expect(await handle.getShared('content.child.failed-intent')).toBeUndefined();
});

it('rejects unrecognized child identity fields instead of ignoring them during reconciliation', async () => {
    await expect(service.createChild({sessionId, requestId: 'unknown-field', title: 'Independent', nativeSessionId: 'external'} as never))
        .rejects.toThrow('CONTENT_CHILD_ARGUMENTS_INVALID');
});

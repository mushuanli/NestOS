import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, registerDurablePrograms, DagCommandService, FlowCommand, FlowDefinitionStore } from '@itookit/llm-flow';
import type { FlowRevision } from '@itookit/llm-flow/contracts';
import { FlowInvocationService } from '../src/session/flow-invocations';
import { CommandBus } from '../src/core/command-bus';
import { SessionManager } from '../src/session/session-manager';
import { SessionRepository } from '../src/persistence/session-repository';
import { SessionDirectoryStorageResolver } from '../src/persistence/session-directory-storage';
import { createSessionPlugin, SessionCommand } from '../src/plugins/session-plugin';
import { prepareFlowConnections } from '../src/session/flow-connections';
import { bindStandaloneFlowNode } from '../src/session/flow-node-binder';
import { checkFlowConnections } from '../src/session/flow-connection-check';
import {flowInvocationId, type FlowInvocationRecord} from '../src/contracts/flow-invocations';

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, service: FlowInvocationService, commands: CommandBus;
const flow: FlowRevision = { id: 'wait' as never, name: 'Wait', revision: 1, digest: 'wait-v1', createdAt: 0,
    parameters: [{ name: 'text', type: 'string', required: true }], nodes: [
        { id: 'ask' as never, name: 'Ask', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'same', prompt: '${param.text}' } },
    ], edges: [] };
const definitions = { loadRevision: async () => flow } as unknown as FlowDefinitionStore;
const input = (requestId: string, text = requestId) => ({ sessionId: 's', requestId, flowId: 'wait', revision: 1, parameters: { text } });

async function finishInvocation(call: FlowInvocationRecord, value = 'Done') {
    let targetId: string | undefined;
    await vi.waitFor(async () => {
        const snapshot = await commands.execute<any>(FlowCommand.RunGet, {sessionId: call.sessionId, taskId: call.rootTaskId});
        targetId = snapshot.taskTree.find((task: any) => task.interactions.same?.status === 'pending')?.id;
        expect(targetId).toBeTruthy();
    });
    await commands.execute(FlowCommand.RunRespond, {taskId: call.rootTaskId, targetTaskId: targetId, requestId: 'same', value});
    expect((await (await kernel.openTask(call.rootTaskId!)).wait({timeoutMs: 3000})).status).toBe('succeeded');
}
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    commands = new CommandBus();
    new DagCommandService({ kernel, flowStore: definitions, plugins: createBuiltinDagPluginRegistry() }).register(commands);
    service = new FlowInvocationService(kernel, definitions, commands);
});
afterEach(async () => { await kernel.closeSession('s', true); kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); });

it('rejects new local root calls through both invocation and raw run commands, without creating tasks or intents', async () => {
    const local = {...flow, exposure: 'local' as const};
    const privateService = new FlowInvocationService(kernel, {loadRevision: async () => local} as never, commands);
    await expect(privateService.invoke({...input('local'), caller: 'flow'} as never)).rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    await expect(commands.execute(FlowCommand.RunStart, {sessionId: 's', flow: local, parameters: {text: 'test'}, caller: 'flow'}))
        .rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    expect(await kernel.listSessionTasks('s')).toEqual([]);
    expect(await privateService.list('s')).toEqual([]);
});

it('resolves public run commands against published scope instead of trusting a forged snapshot', async () => {
    const local = {...flow, exposure: 'local' as const}, bus = new CommandBus();
    const store = {loadRevision: async (_id: string, revision?: number) => revision === undefined || revision === 1 ? local : null};
    new DagCommandService({kernel, flowStore: store as never, plugins: createBuiltinDagPluginRegistry()}).register(bus);
    await expect(bus.execute(FlowCommand.RunStart, {sessionId: 's', flow: {...flow, exposure: 'global'}, parameters: {text: 'test'}}))
        .rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    await expect(bus.execute(FlowCommand.RunStart, {sessionId: 's', flow: {...flow, revision: 999}, parameters: {text: 'test'}}))
        .rejects.toMatchObject({code: 'FLOW_REVISION_NOT_FOUND'});
    expect(await kernel.listSessionTasks('s')).toEqual([]);
});

it('reconciles an accepted frozen call without re-reading a newly local library definition', async () => {
    const original = await service.invoke(input('accepted-global'));
    const loadRevision = vi.fn(async () => ({...flow, exposure: 'local' as const}));
    const reopened = new FlowInvocationService(kernel, {loadRevision} as never, commands);
    expect((await reopened.invoke(input('accepted-global'))).rootTaskId).toBe(original.rootTaskId);
    expect(loadRevision).not.toHaveBeenCalled();
    await expect(reopened.invoke(input('new-local'))).rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    await finishInvocation(original);
});

it('keeps the admitted Invocation on reconciliation and creates a separate linked Invocation for a user rerun', async () => {
    const first = await service.invoke(input('original'));
    expect(first.invocationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await finishInvocation(first);
    const before = (await (await kernel.openTask(first.rootTaskId!)).status()).task;
    const recovered = new FlowInvocationService(kernel, definitions, commands);
    expect((await recovered.invoke(input('original'))).invocationId).toBe(first.invocationId);
    const request = {...input('rerun'), retryOfInvocationId: flowInvocationId(first)};
    const next = await service.invoke(request);
    expect(next.invocationId).not.toBe(first.invocationId); expect(next.rootTaskId).not.toBe(first.rootTaskId);
    expect(next.retryOfInvocationId).toBe(first.invocationId);
    expect((await (await kernel.openTask(next.rootTaskId!)).status()).task.input).toMatchObject({initialScheduler: {spec: {invocation: {
        invocationId: next.invocationId, retryOfInvocationId: first.invocationId, retryOfSessionId: 's'}}}});
    const after = (await (await kernel.openTask(first.rootTaskId!)).status()).task;
    expect({status: after.status, output: after.output, version: after.version}).toEqual({status: before.status, output: before.output, version: before.version});
    expect((await recovered.invoke(request)).rootTaskId).toBe(next.rootTaskId);
    await expect(service.invoke({...request, retryOfInvocationId: 'different-source'})).rejects.toThrow('different arguments');
});

it('requires an identified terminal source and never turns an active or missing source into a rerun', async () => {
    const first = await service.invoke(input('active-source'));
    await expect(service.invoke({...input('premature'), retryOfInvocationId: flowInvocationId(first)}))
        .rejects.toMatchObject({code: 'FLOW_INVOCATION_NOT_TERMINAL'});
    await expect(service.invoke({...input('missing'), retryOfInvocationId: 'missing'}))
        .rejects.toMatchObject({code: 'FLOW_INVOCATION_NOT_FOUND'});
    await expect(service.invoke({...input('foreign'), retryOfInvocationId: first.invocationId, retryOfSessionId: 'outside'}))
        .rejects.toMatchObject({code: 'FLOW_INVOCATION_OUTSIDE_SESSION'});
    expect(await service.list('s')).toHaveLength(1);
});

it('does not accept caller-provided execution identities, plans or source definitions', async () => {
    const call = await service.invoke({...input('trusted-admission'), invocationId: 'forged', rootTaskId: 'foreign-task',
        flow: {...flow, digest: 'forged-definition'}, preparedGraph: {nodes: [], edges: []}, inputResolution: {parameters: {text: 'forged'}}} as never);
    expect(call.invocationId).not.toBe('forged'); expect(call.rootTaskId).not.toBe('foreign-task'); expect(call.flow.digest).toBe(flow.digest);
    expect(call.inputResolution?.parameters).toEqual({text: 'trusted-admission'});
    const root = (await (await kernel.openTask(call.rootTaskId!)).status()).task;
    expect(root.input).toMatchObject({initialScheduler: {spec: {invocation: {invocationId: call.invocationId}}}});
});

it('retains a deterministic legacy Invocation identity without upgrading it during a read or retry', async () => {
    const session = await kernel.openSession('s');
    await session.setShared('flow.invocation.legacy', {...input('legacy'), flow, createdAt: 1} as never);
    const before = await session.getShared('flow.invocation.legacy');
    const [listed] = await service.list('s'); expect(flowInvocationId(listed)).toBe('legacy:s:legacy');
    expect((await session.getShared('flow.invocation.legacy'))?.version).toBe(before?.version);
    const call = await service.invoke(input('legacy')); expect(call.invocationId).toBeUndefined();
    await finishInvocation(call);
    const next = await service.invoke({...input('legacy-rerun'), retryOfInvocationId: flowInvocationId(call)});
    expect(next.retryOfInvocationId).toBe('legacy:s:legacy'); expect(next.invocationId).toBeTruthy();
});

it('uses the winning durable Invocation identity when two service instances race to admit the same request', async () => {
    const other = new FlowInvocationService(kernel, definitions, commands);
    const [first, second] = await Promise.all([service.invoke(input('raced')), other.invoke(input('raced'))]);
    expect(first.invocationId).toBe(second.invocationId); expect(first.rootTaskId).toBe(second.rootTaskId);
    expect((await kernel.listSessionTasks('s')).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).filter(task => task.interactions.same?.status === 'pending')).toHaveLength(1));
});

it('links a child-Session rerun only through the host-verified parent relationship', async () => {
    kernel.registerStorageResolver({kind: 'child', resolve: async () => ({fs: await manager.openFileSystem('/test'), rootPath: '/child'})});
    await kernel.createSession({id: 'child', storage: {kind: 'child', locator: null}});
    try {
        const first = await service.invoke(input('parent-call')); await finishInvocation(first);
        const request = {...input('child-rerun'), sessionId: 'child', retryOfInvocationId: first.invocationId, retryOfSessionId: 's'};
        await expect(service.invoke(request)).rejects.toMatchObject({code: 'FLOW_INVOCATION_OUTSIDE_SESSION'});
        const linked = new FlowInvocationService(kernel, definitions, commands, undefined,
            async id => ({branch: 'main', head: null, parentSessionId: id === 'child' ? 's' : undefined}));
        const next = await linked.invoke(request);
        expect(next.retryOfInvocationId).toBe(first.invocationId); expect(next.invocationId).not.toBe(first.invocationId);
        expect((await linked.list('child'))[0].rootTaskId).toBe(next.rootTaskId);
    } finally {await kernel.closeSession('child', true);}
});

it('refuses to rebind a persisted Invocation to a root carrying another invocation identity', async () => {
    const first = await service.invoke(input('identity-conflict'));
    const session = await kernel.openSession('s'), entry = await session.getShared('flow.invocation.identity-conflict');
    await session.setShared('flow.invocation.identity-conflict', {...entry!.value as object, invocationId: 'another-invocation'} as never);
    const execute = vi.spyOn(commands, 'execute');
    await expect(service.invoke(input('identity-conflict'))).rejects.toMatchObject({code: 'FLOW_INVOCATION_EXECUTION_CONFLICT'});
    expect(execute).not.toHaveBeenCalled();
    expect((await kernel.listSessionTasks('s')).filter(task => task.labels?.kind === 'flow-root').map(task => task.id)).toEqual([first.rootTaskId]);
});

it('admits a composer source through the shared resolver and retains the original submission separately', async () => {
    const definition = {...flow, parameters: [{...flow.parameters![0], inputSource: 'composer.text' as const}]};
    const ownDefinitions = {loadRevision: async () => definition} as unknown as FlowDefinitionStore;
    service = new FlowInvocationService(kernel, ownDefinitions, commands);
    const request = {...input('composer-source'), parameters: {},
        source: {kind: 'composer' as const, text: 'Bound input', attachments: [], values: {}},
        expectedSignature: {id: flow.id, revision: flow.revision, digest: flow.digest}};
    const admitted = await service.invoke(request);
    expect(admitted.parameters).toEqual({});
    expect(admitted.inputResolution).toMatchObject({version: 1, parameters: {text: 'Bound input'}, origins: {text: ['composer.text']}});
    request.source.text = 'Changed later';
    expect(admitted.source).toMatchObject({text: 'Bound input'});
    await expect(service.invoke(request)).rejects.toThrow('different arguments');
});

it('rejects a stale input signature before creating any root execution', async () => {
    const execute = vi.spyOn(commands, 'execute');
    await expect(service.invoke({...input('stale-signature'), expectedSignature: {...flow, digest: 'stale'}}))
        .rejects.toMatchObject({code: 'FLOW_INPUT_SIGNATURE_CHANGED'});
    expect(execute).not.toHaveBeenCalled();
});

it('freezes resolved default values across a failed start without rewriting the original arguments', async () => {
    const definition = {...flow, parameters: [{...flow.parameters![0], default: 'Original default'}]};
    const ownDefinitions = {loadRevision: async () => definition} as unknown as FlowDefinitionStore;
    service = new FlowInvocationService(kernel, ownDefinitions, commands);
    const execute = vi.spyOn(commands, 'execute').mockRejectedValueOnce(new Error('Start unavailable'));
    const request = {...input('default-recovery'), parameters: {}};
    await expect(service.invoke(request)).rejects.toThrow('Start unavailable');
    definition.parameters[0].default = 'Changed default';
    const admitted = await service.invoke(request);
    expect(admitted.parameters).toEqual({});
    expect(admitted.inputResolution?.parameters).toEqual({text: 'Original default'});
    expect(execute).toHaveBeenLastCalledWith(FlowCommand.RunStart, expect.objectContaining({parameters: {text: 'Original default'}}));
});

it('rejects a corrupted resolved input instead of starting it as a new invocation', async () => {
    const execute = vi.spyOn(commands, 'execute').mockRejectedValueOnce(new Error('Start unavailable'));
    const request = input('corrupted-input');
    await expect(service.invoke(request)).rejects.toThrow('Start unavailable');
    const session = await kernel.openSession('s');
    const saved = (await session.getShared('flow.invocation.corrupted-input'))!.value as any;
    saved.inputResolution.parameters.text = 'Corrupted';
    await session.setShared('flow.invocation.corrupted-input', saved);
    await expect(service.invoke(request)).rejects.toMatchObject({code: 'FLOW_INPUT_RESOLUTION_CONFLICT'});
    expect(execute).toHaveBeenCalledOnce();
});

it('does not acquire a write lease or inspect tasks when no invocation exists', async () => {
    const canWrite = vi.fn(async () => false);
    const inspect = vi.spyOn(kernel, 'inspectSession');
    const recovery = new FlowInvocationService(kernel, definitions, commands, canWrite);
    await recovery.recover();
    expect(canWrite).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
});

it('retains the write gate for persisted invocations', async () => {
    await service.invoke(input('owned'));
    const canWrite = vi.fn(async () => false);
    const execute = vi.spyOn(commands, 'execute');
    const recovery = new FlowInvocationService(kernel, definitions, commands, canWrite);
    await recovery.recover();
    expect(canWrite).toHaveBeenCalledWith('s');
    expect(execute).not.toHaveBeenCalled();
});

it('recovers pending invocations without a status probe or a second shared-state scan', async () => {
    await service.invoke(input('probe-free'));
    const stat = vi.spyOn(kernel, 'sessionStat');
    const list = vi.spyOn(FlowInvocationService.prototype, 'list');
    const recovery = new FlowInvocationService(kernel, definitions, commands);
    await recovery.recover();
    expect(stat).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    // The records read for the status check are handed to list() instead of being listed again.
    expect(list.mock.calls[0][1]).toHaveLength(1);
});

it('skips every Session without probing when the persisted marker lists none', async () => {
    const sessions = { sessions: vi.fn(async () => new Set<string>()), mark: vi.fn(async () => {}), establish: vi.fn(async () => {}) };
    const shared = vi.spyOn(kernel, 'listShared');
    const recovery = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, undefined, sessions);
    await recovery.recover();
    expect(sessions.sessions).toHaveBeenCalledTimes(1);
    expect(shared).not.toHaveBeenCalled();
    expect(sessions.establish).not.toHaveBeenCalled();
});

it('seals an unknown marker with an empty set so later boots probe nothing', async () => {
    const sessions = { sessions: vi.fn(async () => undefined as Set<string> | undefined), mark: vi.fn(async () => {}), establish: vi.fn(async () => {}) };
    const recovery = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, undefined, sessions);
    await recovery.recover();
    expect(sessions.establish).toHaveBeenCalledTimes(1);
    expect([...sessions.establish.mock.calls[0][0]]).toEqual([]);
});

it('seals an unknown marker with the Sessions that hold records', async () => {
    await service.invoke(input('legacy'));
    const sessions = { sessions: vi.fn(async () => undefined as Set<string> | undefined), mark: vi.fn(async () => {}), establish: vi.fn(async () => {}) };
    const recovery = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, undefined, sessions);
    await recovery.recover();
    expect([...sessions.establish.mock.calls[0][0]]).toEqual(['s']);
});

it('keeps the marker unknown when a Session could not be probed', async () => {
    await service.invoke(input('unreadable'));
    const sessions = { sessions: vi.fn(async () => undefined as Set<string> | undefined), mark: vi.fn(async () => {}), establish: vi.fn(async () => {}) };
    vi.spyOn(kernel, 'listShared').mockRejectedValueOnce(new Error('Session record missing'));
    const recovery = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, undefined, sessions);
    await recovery.recover();
    expect(sessions.establish).not.toHaveBeenCalled();
});

it('marks a Session before its first invocation record is written', async () => {
    const order: string[] = [];
    const sessions = { sessions: vi.fn(async () => undefined as Set<string> | undefined), mark: vi.fn(async () => { order.push('mark'); }), establish: vi.fn(async () => {}) };
    const open = kernel.openSession.bind(kernel);
    vi.spyOn(kernel, 'openSession').mockImplementation(async (...args: Parameters<typeof open>) => {
        order.push('open');
        return open(...args);
    });
    const recovery = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, undefined, sessions);
    await recovery.invoke(input('marked-first'));
    expect(sessions.mark).toHaveBeenCalledWith('s');
    expect(order[0]).toBe('mark');
    expect(order).toContain('open');
});

it('runs three calls in one Session, deduplicates admission, and routes identical interaction ids to the chosen Run', async () => {
    const [a, b, c, duplicate] = await Promise.all([service.invoke(input('a')), service.invoke(input('b')), service.invoke(input('c')), service.invoke(input('a'))]);
    expect(duplicate.rootTaskId).toBe(a.rootTaskId);
    expect(new Set([a.rootTaskId, b.rootTaskId, c.rootTaskId]).size).toBe(3);
    expect(await service.list('s')).toHaveLength(3);
    const ask = async (id: string) => {
        let snapshot: any;
        await vi.waitFor(async () => { snapshot = await commands.execute(FlowCommand.RunGet, { sessionId: 's', taskId: id });
            expect(snapshot.taskTree.some((task: any) => task.interactions.same?.status === 'pending')).toBe(true); });
        return snapshot.taskTree.find((task: any) => task.interactions.same?.status === 'pending').id;
    };
    const [targetA, targetB] = await Promise.all([ask(a.rootTaskId!), ask(b.rootTaskId!)]);
    await expect(commands.execute(FlowCommand.RunRespond, { taskId: a.rootTaskId, targetTaskId: targetB, requestId: 'same', value: 'wrong' })).rejects.toThrow('outside');
    await commands.execute(FlowCommand.RunRespond, { taskId: a.rootTaskId, targetTaskId: targetA, requestId: 'same', value: 'A' });
    expect((await (await kernel.openTask(a.rootTaskId!)).wait({ timeoutMs: 3000 })).status).toBe('succeeded');
    await commands.execute(FlowCommand.RunCancel, { taskId: b.rootTaskId });
    expect((await (await kernel.openTask(b.rootTaskId!)).status()).task.status).toBe('cancelled');
    expect((await (await kernel.openTask(c.rootTaskId!)).status()).task.status).not.toBe('cancelled');
    await expect(service.invoke(input('a', 'changed'))).rejects.toThrow('different arguments');
});

it('reconciles a lost completion receipt from the durable root without starting a second Run', async () => {
    const call = await service.invoke(input('lost'));
    const session = await kernel.openSession('s');
    const stored = (await session.getShared('flow.invocation.lost'))!.value as any;
    delete stored.rootTaskId;
    await session.setShared('flow.invocation.lost', stored);
    const recovered = new FlowInvocationService(kernel, definitions, commands);
    expect((await recovered.invoke(input('lost'))).rootTaskId).toBe(call.rootTaskId);
    expect((await session.listTasks()).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
    await expect(new FlowInvocationService(kernel, definitions, commands, async () => false).invoke(input('denied'))).rejects.toThrow('another host');
});

it('restores multiple pending calls after rebuilding Kernel and also submits a durable intent without a root', async () => {
    const calls = await Promise.all([service.invoke(input('restore-a')), service.invoke(input('restore-b'))]);
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).filter(task => task.interactions.same?.status === 'pending')).toHaveLength(2));
    const session = await kernel.openSession('s');
    await session.setShared('flow.invocation.intent', { ...input('intent'), flow, createdAt: Date.now() } as never);
    kernel.dispose(); await kernel.waitIdle();
    await vi.waitFor(async () => {
        for (const call of calls) expect(Number(((await session.getShared(`flow.run.${call.rootTaskId}.scheduler-owner`))!.value as any).expiresAt)).toBeLessThanOrEqual(Date.now());
    }, { timeout: 3000 });
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize(); await kernel.recoverSession('s');
    commands = new CommandBus(); new DagCommandService({ kernel, flowStore: definitions, plugins: createBuiltinDagPluginRegistry() }).register(commands);
    service = new FlowInvocationService(kernel, definitions, commands); await service.recover();
    const restored = await service.list('s'); expect(restored).toHaveLength(3);
    expect(restored.find(call => call.requestId === 'restore-a')?.rootTaskId).toBe(calls[0].rootTaskId);
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('s')).filter(task => task.interactions.same?.status === 'pending')).toHaveLength(3));
    for (const call of restored) {
        const snapshot = await commands.execute<any>(FlowCommand.RunGet, { sessionId: 's', taskId: call.rootTaskId });
        const target = snapshot.taskTree.find((task: any) => task.interactions.same?.status === 'pending');
        await commands.execute(FlowCommand.RunRespond, { taskId: call.rootTaskId, targetTaskId: target.id, requestId: 'same', value: call.requestId });
        expect((await (await kernel.openTask(call.rootTaskId!)).wait({ timeoutMs: 3000 })).status).toBe('succeeded');
    }
});

it('starts the launcher call before any view binds the new Session and leaves its chat branch untouched', async () => {
    const fs = await manager.openFileSystem('/sessions');
    const repository = new SessionRepository(fs); await repository.init();
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
    const sessionManager = new SessionManager(repository, {} as never, { kernel,
        dagPlugins: createBuiltinDagPluginRegistry(), flowStore: {} as never, canWriteSession: async () => true });
    service.register();
    commands.register(SessionCommand.CheckFlowConnections, args => checkFlowConnections(args as never, {getDefaultConnection: async () => null} as never, definitions));
    await createSessionPlugin(sessionManager).activate({ commands } as never);
    const create = vi.spyOn(sessionManager, 'createSessionFromFlow');
    const signature = await definitions.loadRevision('wait', 1);
    await expect(commands.execute(SessionCommand.CreateFromFlow, {invocation: true, flowId: 'wait', revision: 1,
        parameters: {text: 'stale form'}, expectedSignature: {id: 'wait', revision: 1, digest: 'stale'}}))
        .rejects.toMatchObject({code: 'FLOW_INPUT_SIGNATURE_CHANGED'});
    expect(create).not.toHaveBeenCalled();
    const created = await commands.execute<{ sessionId: string }>(SessionCommand.CreateFromFlow, {
        invocation: true, flowId: 'wait', revision: 1, parameters: { text: 'launch before navigation' },
        expectedSignature: {id: 'wait', revision: 1, digest: signature!.digest},
    });
    try {
        const calls = await service.list(created.sessionId);
        expect(calls).toHaveLength(1); expect(calls[0].rootTaskId).toBeTruthy();
        expect((await repository.getManifest(created.sessionId))?.flow).toBeUndefined();
        expect(await repository.listHistory(created.sessionId)).toEqual([]);
        await vi.waitFor(async () => expect((await kernel.listSessionTasks(created.sessionId)).some(task => task.interactions.same?.status === 'pending')).toBe(true));
    } finally { await kernel.closeSession(created.sessionId, true); await repository.dispose(); }
});

it('does not scan chat tasks when the Session has no Flow invocations', async () => {
    const tasks = vi.spyOn(kernel, 'listSessionTasks');
    expect(await service.list('s')).toEqual([]);
    expect(tasks).not.toHaveBeenCalled();
    tasks.mockRestore();
});


it('freezes connection selection at admission and rejects reusing an id with another connection', async () => {
    const resolve = vi.fn(async (_session: string, selected?: string) => selected ?? 'global-before');
    service = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, resolve);
    const execute = vi.spyOn(commands, 'execute');
    const call = await service.invoke({ ...input('connection-choice'), connectionId: 'run-choice' });
    expect(call.resolvedConnectionId).toBe('run-choice');
    expect(execute).toHaveBeenCalledWith(FlowCommand.RunStart, expect.objectContaining({ connectionId: 'run-choice', fallbackConnectionId: 'run-choice' }));
    resolve.mockResolvedValue('global-after');
    expect((await service.invoke({ ...input('connection-choice'), connectionId: 'run-choice' })).rootTaskId).toBe(call.rootTaskId);
    expect(resolve).toHaveBeenCalledOnce();
    await expect(service.invoke({ ...input('connection-choice'), connectionId: 'other' })).rejects.toThrow('different arguments');
});


it('retains the admitted fallback when retrying a submission after the global default changes', async () => {
    const resolve = vi.fn(async () => 'global-before');
    service = new FlowInvocationService(kernel, definitions, commands, undefined, undefined, resolve);
    const execute = vi.spyOn(commands, 'execute');
    execute.mockRejectedValueOnce(new Error('submission unavailable'));
    await expect(service.invoke(input('retry-connection'))).rejects.toThrow('submission unavailable');
    resolve.mockResolvedValue('global-after');
    const call = await service.invoke(input('retry-connection'));
    expect(call.resolvedConnectionId).toBe('global-before');
    expect(resolve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenLastCalledWith(FlowCommand.RunStart, expect.objectContaining({ fallbackConnectionId: 'global-before' }));
});

function connectionRuntime(source: 'defaults' | 'run' | 'fallback' | 'nested') {
    kernel.registerEffect({ kind: 'llm.chat', version: '1', async execute() {
        return { choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] };
    } });
    const selection = { model: 'before', enabled: true };
    const provider = { id: 'p', name: 'P', implementation: 'openai-compatible' as const, baseURL: 'https://example.test',
        models: ['before', 'after'].map(id => ({ id, name: id })) };
    const catalog = { getProvider: () => provider, getConnection: vi.fn(async (id: string) => ({
        id, name: id, providerId: 'p', model: selection.model, enabled: selection.enabled, hasApiKey: true, protocol: 'openai-chat' as const,
    })) };
    const agent: FlowRevision = { id: 'agent' as never, name: 'Agent', revision: 1, digest: 'agent', createdAt: 0, edges: [], nodes: [
        { id: 'worker' as never, name: 'Worker', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: { instruction: 'Hello' } },
    ] };
    const definition = structuredClone(agent);
    if (source === 'defaults') {
        definition.connections = [{ name: 'default', connectionId: 'chosen' }];
        definition.defaults = { connectionId: 'default' };
    }
    if (source === 'nested') {
        definition.nodes = [{ id: 'child' as never, name: 'Child', plugin: 'builtin.flow', pluginVersion: '1.0.0', inputs: {}, config: { flowId: 'agent' } }];
        agent.connections = [{ name: 'worker' }]; agent.nodes[0].config = { connectionSlot: 'worker', instruction: 'Hello' };
    }
    const definitions = { loadRevision: async (id: string) => id === 'agent' ? agent : definition } as unknown as FlowDefinitionStore;
    const input = { sessionId: 's', requestId: 'frozen', flowId: 'parent', revision: 1, parameters: {},
        ...(source === 'run' ? { connectionId: 'chosen' } : {}), ...(source === 'nested' ? { connectionBindings: { 'child/worker': 'chosen' } } : {}) };
    const identity = { getSkills: async () => [], getSystemPrompt: async () => undefined, resolveExact: async () => ({}) };
    const options = { kernel, flowStore: definitions, plugins: createBuiltinDagPluginRegistry(),
        bindNode: (sessionId: string, node: FlowRevision['nodes'][number], defaults?: FlowRevision['nodes'][number]['config']) =>
            bindStandaloneFlowNode(node, defaults, sessionId, identity as never),
        prepareConnections: (flow: FlowRevision, bindings?: Record<string, string>) => prepareFlowConnections(flow, bindings, catalog) };
    const create = () => {
        const dag = new DagCommandService(options);
        return { dag, service: new FlowInvocationService(kernel, definitions, commands, undefined, undefined, async () => 'chosen', undefined, dag) };
    };
    return { selection, catalog, input, create, definition };
}

it.each(['defaults', 'run', 'fallback', 'nested'] as const)('persists the complete %s model choice before spawning and reuses it after a failed submission', async source => {
    const fixture = connectionRuntime(source), first = fixture.create();
    vi.spyOn(first.dag, 'submitPrepared').mockRejectedValueOnce(new Error('interrupted before root spawn'));
    await expect(first.service.invoke(fixture.input)).rejects.toThrow('interrupted');
    const session = await kernel.openSession('s');
    const saved = (await session.getShared('flow.invocation.frozen'))!.value as any;
    expect(saved.preparedGraph.nodes[0].config).toMatchObject({ connectionId: 'chosen', modelName: 'before',
        frozenConnection: { providerId: 'p', modelId: 'before' } });
    expect(await session.listTasks()).toEqual([]);
    const lookups = fixture.catalog.getConnection.mock.calls.length;
    fixture.selection.model = 'after';
    const call = await fixture.create().service.invoke(fixture.input);
    const root = (await (await kernel.openTask(call.rootTaskId!)).status()).task;
    expect((root.input as any).initialScheduler.spec.nodes[0].config).toMatchObject({ modelName: 'before' });
    expect(fixture.catalog.getConnection).toHaveBeenCalledTimes(lookups);
    expect((await session.getShared('flow.invocation.frozen'))!.value).not.toHaveProperty('preparedGraph');
    expect(call.preparedGraph).toBeUndefined();
});

it('rejects invalid effective connections before persisting a new invocation', async () => {
    const fixture = connectionRuntime('fallback'); fixture.selection.enabled = false;
    await expect(fixture.create().service.invoke(fixture.input)).rejects.toThrow('unavailable');
    const session = await kernel.openSession('s');
    expect(await session.getShared('flow.invocation.frozen')).toBeUndefined();
    expect(await session.listTasks()).toEqual([]);
});

it('checks connection bindings when deduplicating an admitted request', async () => {
    const fixture = connectionRuntime('nested'), first = fixture.create();
    vi.spyOn(first.dag, 'submitPrepared').mockRejectedValueOnce(new Error('interrupted'));
    await expect(first.service.invoke(fixture.input)).rejects.toThrow('interrupted');
    await expect(fixture.create().service.invoke({ ...fixture.input, connectionBindings: { 'child/worker': 'other' } }))
        .rejects.toThrow('different arguments');
});

it('recovers an interrupted admission with the persisted graph after model configuration changes', async () => {
    const fixture = connectionRuntime('nested'), first = fixture.create();
    vi.spyOn(first.dag, 'submitPrepared').mockRejectedValueOnce(new Error('interrupted'));
    await expect(first.service.invoke(fixture.input)).rejects.toThrow('interrupted');
    const session = await kernel.openSession('s');
    const saved = (await session.getShared('flow.invocation.frozen'))!.value as any;
    delete saved.error;
    await session.setShared('flow.invocation.frozen', saved);
    fixture.selection.model = 'after';
    const recovered = fixture.create().service;
    await recovered.recover();
    const [call] = await recovered.list('s');
    const root = (await (await kernel.openTask(call.rootTaskId!)).status()).task;
    expect((root.input as any).initialScheduler.spec.nodes[0].config).toMatchObject({ modelName: 'before' });
});

it('prepares a legacy intent without a root before submitting it', async () => {
    const fixture = connectionRuntime('fallback'), session = await kernel.openSession('s');
    await session.setShared('flow.invocation.frozen', { ...fixture.input, flow: fixture.definition, createdAt: 0,
        resolvedConnectionId: 'chosen' } as never);
    const call = await fixture.create().service.invoke(fixture.input);
    const root = (await (await kernel.openTask(call.rootTaskId!)).status()).task;
    expect((root.input as any).initialScheduler.spec.nodes[0].config).toMatchObject({ modelName: 'before' });
});

it('reattaches an existing root without compiling or reading the model catalog again', async () => {
    const fixture = connectionRuntime('run'), first = await fixture.create().service.invoke(fixture.input);
    const lookups = fixture.catalog.getConnection.mock.calls.length;
    fixture.selection.enabled = false;
    const repeated = await fixture.create().service.invoke(fixture.input);
    expect(repeated.rootTaskId).toBe(first.rootTaskId);
    expect(fixture.catalog.getConnection).toHaveBeenCalledTimes(lookups);
    expect((await kernel.listSessionTasks('s')).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
});

it('removes an admission graph left behind after the durable root was created', async () => {
    const fixture = connectionRuntime('run'), call = await fixture.create().service.invoke(fixture.input);
    const session = await kernel.openSession('s'), root = (await (await kernel.openTask(call.rootTaskId!)).status()).task;
    await session.setShared('flow.invocation.frozen', { ...call, rootTaskId: undefined,
        preparedGraph: (root.input as any).initialScheduler.spec } as never);
    const lookups = fixture.catalog.getConnection.mock.calls.length;
    fixture.selection.enabled = false;
    await fixture.create().service.recover();
    const saved = (await session.getShared('flow.invocation.frozen'))!.value as any;
    expect(saved.rootTaskId).toBe(call.rootTaskId); expect(saved).not.toHaveProperty('preparedGraph');
    expect(fixture.catalog.getConnection).toHaveBeenCalledTimes(lookups);
    expect((await session.listTasks()).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
});

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

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, service: FlowInvocationService, commands: CommandBus;
const flow: FlowRevision = { id: 'wait' as never, name: 'Wait', revision: 1, digest: 'wait-v1', createdAt: 0,
    parameters: [{ name: 'text', type: 'string', required: true }], nodes: [
        { id: 'ask' as never, name: 'Ask', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'same', prompt: '${param.text}' } },
    ], edges: [] };
const definitions = { loadRevision: async () => flow } as unknown as FlowDefinitionStore;
const input = (requestId: string, text = requestId) => ({ sessionId: 's', requestId, flowId: 'wait', revision: 1, parameters: { text } });
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
    await createSessionPlugin(sessionManager).activate({ commands } as never);
    const created = await commands.execute<{ sessionId: string }>(SessionCommand.CreateFromFlow, {
        invocation: true, flowId: 'wait', revision: 1, parameters: { text: 'launch before navigation' },
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

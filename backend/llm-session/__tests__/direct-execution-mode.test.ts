import { SessionRepository } from '../src/persistence/session-repository';
import { resolveSessionExecutionMode } from '../src/session/session-execution-mode';
import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { DEFAULT_AGENT_MAX_EXCHANGES, type ChatExecutionMode } from '@itookit/llm-tasks/contracts';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';
import { SessionRunCoordinator } from '../src/session/session-run-coordinator';
import type { ExecutionTask, TaskInput } from '../src/core/types';

it.each([
    ['chat', ['write_file'], 'disabled', 'llm.chat', []],
    ['chat', ['write_file', 'WebSearch'], 'client-tool', 'llm.agent', ['WebSearch']],
    ['chat', ['write_file', 'WebSearch'], 'builtin', 'llm.chat', []],
    ['agent', ['write_file'], 'disabled', 'llm.agent', ['write_file']],
    ['agent', undefined, 'disabled', 'llm.agent', ['write_file']],
    ['agent', [], 'disabled', 'rejected', []],
    ['chat', undefined, 'disabled', 'llm.chat', []],
    [undefined, ['write_file'], 'disabled', 'llm.agent', ['write_file']],
] as const)('freezes %s mode with tools %j and search %s', async (mode, ids, search, program, allowed) => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) });
    await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    try {
        // Return an overbroad catalog to verify admission also filters at the Task boundary.
        const resolveTools = vi.fn(async () => ({ definitions: [{ name: 'write_file' }, { name: 'WebSearch' }], externalIds: ['write_file'] }));
        const resolveHarnessToolIds = vi.fn(async () => ['write_file']);
        const policy = mode === 'agent' && ids === undefined ? { systemPrompt: ['Host custom policy'], maxExchanges: 3, llmRetry: { retries: 8, backoffMs: 20 }, toolTimeoutMs: 2500 } : undefined;
        const coordinator = new ConversationRunCoordinator({ directAgentPolicy: policy, kernel, resolveTools, resolveHarnessToolIds, engine: {}, eventBus: {}, dagPlugins: {} } as never);
        if (policy) { policy.systemPrompt[0] = 'Changed after construction'; policy.maxExchanges = 99; policy.llmRetry.retries = 0; }
        const internal = coordinator as any;
        vi.spyOn(internal, 'startRound').mockResolvedValue(undefined);
        vi.spyOn(internal, 'projectRun').mockReturnValue(undefined);
        vi.spyOn(internal, 'consume').mockResolvedValue({ message: { role: 'assistant', content: 'done' } });
        vi.spyOn(internal, 'completeRound').mockResolvedValue(undefined);
        const execution = { task: { id: 'request', sessionId: 's', input: { text: 'goal',
            sendIntent: { execution: { kind: 'agent', agentId: 'a', mode } } }, abortController: new AbortController() },
            config: { id: 'a', systemPrompt: 'policy', webSearchMode: search, capabilityPolicy: ids ? { toolIds: [...ids] } : undefined },
            log: { loadManifest: async () => ({ currentBranch: 'main', branches: { main: null }, branchMeta: {} }) },
            roundId: 'r', contextFiles: [], finalize: async () => {} };
        if (program === 'rejected') {
            await expect(coordinator.executeDirect(execution as never)).rejects.toThrow('No tools are available');
            expect(resolveHarnessToolIds).not.toHaveBeenCalled();
            expect(await kernel.listSessionTasks('s')).toEqual([]);
            return;
        }
        await coordinator.executeDirect(execution as never);
        const [task] = await kernel.listSessionTasks('s');
        expect(task.program.kind).toBe(program);
        expect(task.input).toMatchObject({ tools: allowed.map(name => ({ name })), allowedToolIds: [...allowed], approval: 'external', webSearch: search === 'builtin' });
        expect(resolveTools).toHaveBeenCalledWith('s', [...allowed]);
        expect(task.labels?.executionMode).toBe(mode);
        expect(resolveHarnessToolIds).toHaveBeenCalledTimes(mode === 'agent' && ids === undefined ? 1 : 0);
        if (mode === 'agent') expect(task.input).toMatchObject({ maxExchanges: policy ? 3 : DEFAULT_AGENT_MAX_EXCHANGES });
        expect(JSON.stringify(task.input)).not.toContain('Execute the user request with the available tools');
        if (policy) {
            expect(task.input).toMatchObject({ llmRetry: { retries: 8, backoffMs: 20 }, toolTimeoutMs: 2500 });
            expect(JSON.stringify(task.input)).toContain('Host custom policy');
            expect(JSON.stringify(task.input)).not.toContain('Changed after construction');
        }
        execution.task.input.sendIntent.execution.mode = 'agent';
        expect((await kernel.listSessionTasks('s'))[0].labels?.executionMode).toBe(mode);
    } finally { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); }
});

it('captures mode before asynchronous admission', async () => {
    const coordinator = new SessionRunCoordinator(...Array(8).fill({}) as ConstructorParameters<typeof SessionRunCoordinator>);
    const internal = coordinator as any;
    let admit!: () => void;
    vi.spyOn(coordinator, 'assertCanSubmit').mockImplementation(() => new Promise(resolve => { admit = resolve; }));
    const captured: TaskInput[] = [];
    vi.spyOn(internal, 'createTask').mockImplementation(async (input: TaskInput) => {
        captured.push(input); return { id: 'r', sessionId: 's', input } as ExecutionTask;
    });
    vi.spyOn(internal, 'execute').mockResolvedValue(undefined);
    internal.callbacks = { onStatusChange: vi.fn() };
    const input = { sessionId: 's', text: 'goal', files: [], agentId: 'a',
        overrides: { executionMode: 'chat' as ChatExecutionMode },
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'a', mode: 'chat' } },
    } as TaskInput;
    const pending = coordinator.submit(input, {} as never);
    input.overrides!.executionMode = 'agent';
    if (input.sendIntent!.execution.kind === 'agent') input.sendIntent!.execution.mode = 'agent';
    admit(); await pending;
    expect(captured[0].sendIntent?.execution).toMatchObject({ mode: 'chat' });
    expect(captured[0].overrides?.executionMode).toBe('chat');
});

it.each(['agent', 'chat'] as const)('resolves configured MCP profiles only for %s execution and freezes their tool grants', async mode => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) });
    await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    try {
        const name = 'mcp__server__lookup';
        const resolveMCPToolIds = vi.fn(async () => [name]);
        const coordinator = new ConversationRunCoordinator({ kernel, resolveMCPToolIds,
            resolveTools: async () => ({ definitions: [{ name }], externalIds: [name] }), engine: {}, eventBus: {}, dagPlugins: {} } as never);
        const internal = coordinator as any;
        vi.spyOn(internal, 'startRound').mockResolvedValue(undefined);
        vi.spyOn(internal, 'projectRun').mockReturnValue(undefined);
        vi.spyOn(internal, 'consume').mockResolvedValue({ message: { role: 'assistant', content: 'done' } });
        vi.spyOn(internal, 'completeRound').mockResolvedValue(undefined);
        const policy = { toolIds: [], mcpProfileIds: ['server'] };
        await coordinator.executeDirect({ task: { id: 'request', sessionId: 's', input: { text: 'lookup',
            sendIntent: { execution: { kind: 'agent', mode } } }, abortController: new AbortController() },
            config: { id: 'a', capabilityPolicy: policy, webSearchMode: 'disabled' },
            log: { loadManifest: async () => ({ currentBranch: 'main', branches: { main: null }, branchMeta: {} }) },
            roundId: 'r', contextFiles: [], finalize: async () => {} } as never);
        const [task] = await kernel.listSessionTasks('s');
        expect(task.input).toMatchObject({ tools: mode === 'agent' ? [{ name }] : [], allowedToolIds: mode === 'agent' ? [name] : [], approval: 'external' });
        expect(resolveMCPToolIds).toHaveBeenCalledTimes(mode === 'agent' ? 1 : 0);
        expect(policy.toolIds).toEqual([]);
    } finally { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); }
});

it('persists explicit project-draft provenance before emitting the projected notification', async () => {
    const source = { id: 'submission-a', source: { kind: 'project-draft', ownerId: 'p', id: 'draft-a' } };
    const events: unknown[] = [], writes: unknown[] = [];
    const coordinator = new ConversationRunCoordinator({ eventBus: { emitGlobal: (event: unknown) => {
        expect(writes).toHaveLength(1); events.push(event);
    } } } as never);
    const execution = { roundId: source.id, contextFiles: [],
        task: { sessionId: 's', input: { text: 'hello', sendIntent: { submission: source, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'default' } } } },
        log: { readRound: async () => null, appendExpected: async (_ref: string, round: unknown) => { writes.push(round); } },
    };
    await (coordinator as any).startRound(execution, { branchRef: 'main', branchHead: null }, 'task-a');
    (coordinator as any).projectRun(execution, 'task-a');
    expect(writes[0]).toMatchObject({ id: 'submission-a', sessionId: 's', submission: source,
        executions: [{ taskId: 'task-a', role: 'primary' }] });
    expect(events[0]).toMatchObject({ type: 'execution_task_projected', payload: { submission: source, roundId: 'submission-a' } });
});

it('enforces a persisted mode for sends and regenerations, including callers without overrides', async () => {
    const engine = { getSessionSettings: vi.fn(async () => ({ executionMode: 'agent', executionModeLocked: true })) };
    const input = { sessionId: 's', text: 'next', files: [], agentId: 'a' } as TaskInput;
    expect((await resolveSessionExecutionMode(engine as never, input)).overrides?.executionMode).toBe('agent');
    await expect(resolveSessionExecutionMode(engine as never, { ...input, overrides: { executionMode: 'chat' } })).rejects.toThrow();
    const flow = { ...input, overrides: { flowId: 'flow', executionMode: 'chat' as const } };
    expect(await resolveSessionExecutionMode(engine as never, flow)).toBe(flow);
});

it('locks mode at admission and leaves rejected first submissions configurable', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    try {
        const sessionId = await repository.createSession('Mode');
        const coordinator = new SessionRunCoordinator(...[repository, ...Array(7).fill({})] as ConstructorParameters<typeof SessionRunCoordinator>);
        const internal = coordinator as any;
        vi.spyOn(coordinator, 'assertCanSubmit').mockResolvedValue(undefined);
        const resolve = vi.spyOn(internal, 'resolveConfig').mockRejectedValueOnce(new Error('Invalid agent'))
            .mockResolvedValue({ id: 'a', agentVersion: '1' });
        vi.spyOn(internal, 'execute').mockResolvedValue(undefined);
        internal.callbacks = { onStatusChange: vi.fn() };
        const input = { sessionId, text: 'goal', files: [], agentId: 'a', overrides: { executionMode: 'agent' } } as TaskInput;
        await expect(coordinator.submit(input, {} as never)).rejects.toThrow('Invalid agent');
        expect((await repository.getSessionSettings(sessionId)).executionModeLocked).toBe(false);
        await coordinator.submit(input, {} as never);
        expect((await repository.getSessionSettings(sessionId))).toMatchObject({ executionMode: 'agent', executionModeLocked: true });
        internal.active.clear();
        await expect(coordinator.submit({ ...input, overrides: { executionMode: 'chat' } }, {} as never)).rejects.toThrow();
        expect(resolve).toHaveBeenCalledTimes(2);
    } finally { await repository.dispose(); await manager.dispose(); }
});

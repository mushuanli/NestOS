import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { FlowAggregateProgram, FlowHumanProgram, FlowValueProgram, createBuiltinDagPluginRegistry } from '@itookit/llm-flow';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';

async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/module/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session/.kernel' }; } });
    kernel.registerProgram(new FlowAggregateProgram());
    kernel.registerProgram(new FlowHumanProgram());
    kernel.registerProgram(new FlowValueProgram());
    await kernel.initialize();
    await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });

    const coordinator = new ConversationRunCoordinator({
        kernel,
        eventBus: { emitGlobal: vi.fn(), emitSession: vi.fn() },
        dagPlugins: createBuiltinDagPluginRegistry(),
        engine: {},
        loadArtifact: async () => null,
    } as never);
    const internal = coordinator as any;
    vi.spyOn(internal.contextBuilder, 'resolveLocation').mockResolvedValue({ branchRef: 'main', branchHead: null });
    vi.spyOn(internal.contextBuilder, 'assemble').mockResolvedValue({ blocks: [], canonicalMessages: [] });
    vi.spyOn(internal, 'startRound').mockResolvedValue(undefined);
    vi.spyOn(internal, 'projectRun').mockImplementation(() => {});
    vi.spyOn(internal, 'completeRound').mockResolvedValue(undefined);
    vi.spyOn(internal, 'failRound').mockResolvedValue(undefined);
    return {
        coordinator, kernel,
        async dispose() { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); },
    };
}

function execution() {
    return {
        task: { id: 'run', sessionId: 'session', input: { text: 'go' }, abortController: new AbortController() },
        config: { id: 'agent', name: 'Agent', type: 'agent' },
        roundId: 'round',
        finalize: vi.fn(async () => {}),
        contextFiles: [],
    };
}

function humanFlow() {
    return {
        nodes: [
            { id: 'a', name: 'A', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'a', prompt: 'A' } },
            { id: 'b', name: 'B', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'b', prompt: 'B' } },
            { id: 'result', name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: { operation: 'identity', outputName: 'result', type: 'text', value: null } },
        ],
        edges: [
            { id: 'a-b', from: 'a', to: 'b', input: 'input', output: 'response' },
            { id: 'b-result', from: 'b', to: 'result', input: 'input', output: 'response' },
        ],
    };
}

it('routes responses to DAG nodes created after submission', async () => {
    const system = await setup();
    try {
        const running = system.coordinator.executeDag(execution() as never, undefined, humanFlow);
        await vi.waitFor(async () => {
            expect((await system.kernel.listSessionTasks('session'))
                .some(task => task.labels?.flowNodeId === 'a' && task.interactions?.a?.status === 'pending')).toBe(true);
        });
        await vi.waitFor(() => {
            expect(system.coordinator.signal('session', { type: 'respond', requestId: 'a', response: 'A ok' })).toBe(true);
        });

        await vi.waitFor(async () => {
            expect((await system.kernel.listSessionTasks('session'))
                .some(task => task.labels?.flowNodeId === 'b' && task.interactions?.b?.status === 'pending')).toBe(true);
        });
        expect(system.coordinator.signal('session', { type: 'respond', requestId: 'b', response: 'B ok' })).toBe(true);

        await running;
        const tasks = await system.kernel.listSessionTasks('session');
        expect(tasks.find(task => task.labels?.flowNodeId === 'a')?.status).toBe('succeeded');
        expect(tasks.find(task => task.labels?.flowNodeId === 'b')?.status).toBe('succeeded');
    } finally {
        await system.dispose();
    }
}, 15_000);

it.each(['cancel', 'cancelAll'])('cancels the DAG root before it can create successors (%s)', async operation => {
    const system = await setup();
    try {
        const running = system.coordinator.executeDag(execution() as never, undefined, humanFlow)
            .catch(error => error as Error);
        await vi.waitFor(async () => {
            expect((await system.kernel.listSessionTasks('session'))
                .some(task => task.labels?.flowNodeId === 'a' && task.interactions?.a?.status === 'pending')).toBe(true);
            expect((system.coordinator as any).active.has('session')).toBe(true);
        });

        if (operation === 'cancel') system.coordinator.cancel('session');
        else system.coordinator.cancelAll();

        await vi.waitFor(async () => {
            const root = (await system.kernel.listSessionTasks('session')).find(task => task.labels?.kind === 'flow-root');
            expect(root?.status).toBe('cancelled');
        });
        expect(await running).toBeInstanceOf(Error);

        const tasks = await system.kernel.listSessionTasks('session');
        expect(tasks.find(task => task.labels?.flowNodeId === 'a')?.status).toBe('cancelled');
        expect(tasks.some(task => task.labels?.flowNodeId === 'b')).toBe(false);
    } finally {
        await system.dispose();
    }
}, 15_000);

it('cancels an admitted run if its initial Round cannot be persisted', async () => {
    const system = await setup();
    try {
        const failure = new Error('Round storage unavailable');
        vi.mocked((system.coordinator as any).startRound).mockRejectedValue(failure);
        await expect(system.coordinator.executeDag(execution() as never, undefined, humanFlow)).rejects.toBe(failure);
        await vi.waitFor(async () => {
            const tasks = await system.kernel.listSessionTasks('session');
            expect(tasks.length).toBeGreaterThan(0);
            expect(tasks.every(task => ['cancelled', 'succeeded', 'failed'].includes(task.status))).toBe(true);
        });
        expect((system.coordinator as any).active.size).toBe(0);
    } finally { await system.dispose(); }
});

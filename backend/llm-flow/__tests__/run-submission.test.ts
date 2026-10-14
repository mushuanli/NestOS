import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IVFSManager } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms, submitRun } from '../src';
import type { TaskRunDefinition } from '../src';

let kernel: Kernel;
let manager: IVFSManager;
let executor: DurableFlowExecutor;
const model = vi.fn(async () => ({ choices: [{ index: 0,
    message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));

beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session/.kernel' }; } });
    registerDurablePrograms(kernel);
    model.mockClear();
    kernel.registerEffect({ kind: 'llm.chat', version: '1', execute: model });
    await kernel.initialize();
    await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
});

afterEach(async () => {
    await executor.waitIdle();
    await kernel.dispose();
    await kernel.waitIdle();
    await manager.dispose();
});

it.each(['llm.chat', 'llm.agent'])('%s completes each turn without a pending human interaction or graph root', async kind => {
    const first = await submitRun(taskDefinition(kind), { kernel });
    expect((await first.root.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
    expect((await first.root.status()).task.interactions).toEqual({});
    const second = await submitRun(taskDefinition(kind), { kernel });
    expect((await second.root.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
    expect(second.root.id).not.toBe(first.root.id);
    expect((await kernel.listSessionTasks('session')).map(task => task.program.kind)).toEqual([kind, kind]);
    expect(model).toHaveBeenCalledTimes(2);
    expect(first.tasks()).toEqual([first.root]);
});

it('keeps plan approval inside the same task and completes without executing the plan', async () => {
    const definition = taskDefinition('llm.plan');
    definition.task.input = { sessionId: 'session', roundId: 'round', connectionId: 'default', goal: 'Ship it' };
    const run = await submitRun(definition, { kernel });
    await vi.waitFor(async () => expect((await run.root.status()).task.interactions['approve:plan']?.status).toBe('pending'));
    await run.root.respond({ interactionId: 'approve:plan', value: { approved: true } });
    expect(await run.root.wait({ timeoutMs: 2000 })).toMatchObject({ status: 'succeeded', output: { plan: 'Done', approved: true } });
    expect(await kernel.listSessionTasks('session')).toHaveLength(1);
    expect(model).toHaveBeenCalledOnce();
});

it('exposes graph tasks created after submission and responds to the member interaction', async () => {
    const run = await submitRun({ kind: 'graph', sessionId: 'session', graph: { nodes: [{
        id: 'human', name: 'Human', plugin: 'builtin.human', pluginVersion: '1.0.0',
        config: { requestId: 'review', prompt: 'Review' },
    }], edges: [] } }, { kernel, flowExecutor: executor });
    await vi.waitFor(() => expect(run.tasks()).toHaveLength(1));
    const human = run.tasks()[0];
    expect(human.id).not.toBe(run.root.id);
    await vi.waitFor(async () => expect((await human.status()).task.interactions.review?.status).toBe('pending'));
    await human.respond({ interactionId: 'review', value: 'accepted' });
    expect((await run.root.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
    expect(run.flow.nodes.get('human')?.id).toBe(human.id);
});

it('rejects a graph without an executor before persisting a task', async () => {
    await expect(submitRun({ kind: 'graph', sessionId: 'session', graph: { nodes: [], edges: [] } }, { kernel }))
        .rejects.toThrow('Graph run requires a flow executor');
    expect(await kernel.listSessionTasks('session')).toHaveLength(0);
});

function taskDefinition(kind: string): TaskRunDefinition {
    return {
        kind: 'task', sessionId: 'session',
        task: { program: { kind, version: '1' }, input: {
            sessionId: 'session', roundId: 'round', connectionId: 'default',
            messages: [{ role: 'user', content: 'Hello' }],
        } },
        capabilities: [{ kind: 'llm', uri: 'llm://test', rights: ['execute'], signalKey: 'llmHandleId' }],
    };
}

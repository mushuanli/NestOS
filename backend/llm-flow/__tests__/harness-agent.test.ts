import { expect, it, vi } from 'vitest';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';
import { flowToDag } from '../src/flow/to-dag';
import { FlowTaskFactory } from '../src/flow/task-factory';
import { bindFlowTaskCapabilities } from '../src/flow/task-capabilities';

const connection = { version: 1, revision: 1, id: 'remote', name: 'Remote', kind: 'harness',
    nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: { root: '/workspace' } };
const config = () => ({ execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: structuredClone(connection),
    messages: [{ role: 'system', content: 'Review policy' }, { role: 'user', content: 'Review project' }] });

it('creates a frozen harness Program and passes dependencies without local tools or model acquisition', async () => {
    const plugins = createBuiltinDagPluginRegistry(), runtime = await plugins.loadRuntime('builtin.agent');
    const input = config(), dependencies = [{ taskId: 'upstream', inputName: 'source', outputName: 'result' }];
    const task = runtime.createTask({ config: { ...input, includeDependencyOutputs: true }, inputs: {}, dependencies,
        sessionId: 's', nodeRunId: 'remote' } as never);
    input.harnessConnection.project.root = '/changed';
    expect(task).toMatchObject({ programKind: 'kernel-adapters.harness', programVersion: '1',
        input: { connection, messages: config().messages, dependencies, includeDependencyOutputs: true } });
    const resolveTools = vi.fn(), resolveSkillContexts = vi.fn();
    const factory = new FlowTaskFactory({ sessionId: 's', plugins, contextProgramVersion: '2', resolveTools, resolveSkillContexts });
    const spec = await factory.create({ id: 'remote', capabilities: ['Bash'], config: { skillIds: ['local'] } } as never, task, []);
    expect(spec).toMatchObject({ program: { kind: 'kernel-adapters.harness', version: '1' }, deferStart: true });
    expect(spec.input).not.toHaveProperty('tools');
    expect(resolveTools).not.toHaveBeenCalled();
    expect(resolveSkillContexts).not.toHaveBeenCalled();
});

it('grants only the remote execution capability even when inherited tool ids and budgets exist', async () => {
    const task = { createResource: vi.fn(async () => ({ handle: { id: 'remote-handle' } })), start: vi.fn() };
    const session = { setBudget: vi.fn() };
    await bindFlowTaskCapabilities(session as never, task as never, 'kernel-adapters.harness', ['Bash'], { tokens: 50 });
    expect(task.createResource).toHaveBeenCalledTimes(1);
    expect(task.createResource).toHaveBeenCalledWith({ requestId: 'capability:harnessHandleId', kind: 'harness',
        uri: 'harness://flow', rights: ['execute'] });
    expect(task.start).toHaveBeenCalledWith({ signal: { type: 'capabilities', payload: { harnessHandleId: 'remote-handle' } } });
    expect(session.setBudget).not.toHaveBeenCalled();
});

it.each([undefined, true, false])('preserves the shared Agent dependency policy when configured as %s', async value => {
    const runtime = await createBuiltinDagPluginRegistry().loadRuntime('builtin.agent');
    const task = runtime.createTask({ config: { ...config(), includeDependencyOutputs: value }, inputs: {}, dependencies: [],
        sessionId: 's', nodeRunId: 'node' } as never);
    expect(task.input).toMatchObject({ includeDependencyOutputs: value !== false });
});

it.each([4500, 0, 'invalid'])('forwards an explicit timeout unchanged for strict Program validation: %s', async timeoutMs => {
    const runtime = await createBuiltinDagPluginRegistry().loadRuntime('builtin.agent');
    const task = runtime.createTask({ config: { ...config(), timeoutMs }, inputs: {}, dependencies: [], sessionId: 's', nodeRunId: 'node' } as never);
    expect(task.input).toHaveProperty('timeoutMs', timeoutMs);
});

it('keeps a harness node independent from Flow model defaults', async () => {
    const graph = await flowToDag({ id: 'flow', revision: 1, name: 'Remote', createdAt: 0, digest: '', edges: [],
        connections: [{ name: 'chat', connectionId: 'model-connection' }], defaultConnection: 'chat',
        defaults: { connectionId: 'chat', modelName: 'local-model' },
        nodes: [{ id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', config: config(), inputs: {} }] } as never);
    expect(graph.nodes[0].config).toMatchObject({ execution: { kind: 'harness', connectionId: 'remote' } });
    expect(graph.nodes[0].config).not.toHaveProperty('connectionId');
    expect(graph.nodes[0].config).not.toHaveProperty('connectionSlot');
    expect(graph.nodes[0].config).not.toHaveProperty('modelName');
});

it.each([
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,a' } }] }] }, 'text messages only'],
    [{ harnessConnection: { ...connection, id: 'other' } }, 'does not match'],
    [{ harnessConnection: undefined }, 'snapshot is required'],
    [{ delegation: { enabled: true } }, 'cannot host local delegation'],
    [{ subtasks: { template: { config: { connectionId: 'local' } } } }, 'cannot host local delegation'],
])('rejects unsupported remote input before Task creation: %j', async (patch, message) => {
    const runtime = await createBuiltinDagPluginRegistry().loadRuntime('builtin.agent');
    expect(() => runtime.createTask({ config: { ...config(), ...patch }, inputs: {}, dependencies: [],
        sessionId: 's', nodeRunId: 'node' } as never)).toThrow(message);
});

import { expect, it, vi } from 'vitest';
import type { HarnessConnectionSnapshot } from '@itookit/kernel-adapters/contracts';
import { AgentResolver } from '../src/session/agent-resolver';
import { SessionRunCoordinator } from '../src/session/session-run-coordinator';
import { bindStandaloneFlowNode } from '../src/session/flow-node-binder';
import { prepareFlowConnections } from '../src/session/flow-connections';
import { validatePlannedFlowConnections } from '../src/session/flow-run-plan';
import { frozenFlowIdentities } from '../src/session/flow-identity-snapshot';
import { directTaskSpec, prepareDirectConversation } from '../src/session/direct-conversation';
import type { TaskInput } from '../src/core/types';

function fixture() {
    const connection: HarnessConnectionSnapshot = { version: 1, revision: 1, id: 'remote', name: 'Remote', kind: 'harness',
        nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: { root: '/workspace' } };
    const definition = { id: 'reviewer', name: 'Reviewer', type: 'agent', version: '1', config: {},
        execution: { kind: 'harness', connectionId: 'remote' }, capabilityPolicy: { toolIds: ['Bash'], mcpProfileIds: ['local'] } };
    const service = { getAgentConfig: vi.fn(async () => definition), getHarnessConnection: vi.fn(async () => connection),
        getConnection: vi.fn(async () => { throw new Error('Local model access is forbidden'); }), getProvider: vi.fn(),
        getDefaultConnection: vi.fn(), getModelDefaults: vi.fn(async () => ({})), getSkills: vi.fn(async () => []) };
    return { connection, definition, service, resolver: new AgentResolver(service as never) };
}

it('resolves a remote Agent without any model and fails closed when authorization is withdrawn', async () => {
    const { resolver, connection, service } = fixture();
    const config = await resolver.resolveExact('reviewer');
    expect(config.harnessConnection).toEqual(connection);
    expect(await resolver.reResolveModel(config, { useDefault: true })).toMatchObject({ execution: { kind: 'harness' } });
    expect(service.getConnection).not.toHaveBeenCalled();
    expect(service.getDefaultConnection).not.toHaveBeenCalled();
    connection.enabled = false;
    await expect(resolver.resolveForChat('reviewer')).rejects.toThrow('unavailable or unauthorized');
});

it('freezes queued Agent identity and revalidates its original target after Agent defaults change', async () => {
    const { resolver, connection, service, definition } = fixture();
    const coordinator = new SessionRunCoordinator(...[{}, {}, resolver, ...Array(5).fill({})] as ConstructorParameters<typeof SessionRunCoordinator>);
    const instruction = { id: 'instruction', agentId: 'reviewer', text: 'Review', files: [], branch: 'main', createdAt: 0, state: 'pending' };
    const admitted = await coordinator.bindQueuedInstruction('session', instruction as never);
    expect(admitted.connectionBinding).toMatchObject({ defaults: {}, harnessAgent: { execution: definition.execution, harnessConnection: connection } });
    definition.execution.connectionId = 'new-default';
    service.getAgentConfig.mockRejectedValue(new Error('Agent source is unavailable'));
    const input = { sessionId: 'session', agentId: 'reviewer', text: 'Review', files: [], instructionConnectionBinding: admitted.connectionBinding } as TaskInput;
    await expect((coordinator as any).prepareFlowInput(input)).resolves.toEqual(input);
    await expect(coordinator.validateSubmission(input)).resolves.toBeUndefined();
    expect(service.getAgentConfig).toHaveBeenCalledTimes(1);
    connection.revision++;
    await expect(coordinator.validateSubmission(input)).rejects.toThrow('changed after admission');
    await expect(coordinator.validateSubmission({ ...input, agentId: 'another' })).rejects.toThrow('Invalid admitted harness Agent identity');
});

it('binds remote Flow identities without inheriting model slots, tools or MCP authority', async () => {
    const { resolver, connection, service } = fixture();
    const node = { id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
        config: { agentId: 'reviewer', instruction: 'Review' }, capabilities: ['Bash'] };
    const bound = await bindStandaloneFlowNode(node as never, { connectionId: 'model', modelName: 'local-model', toolIds: ['Bash'] }, 'session', resolver);
    expect(bound.config).toMatchObject({ execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: connection, toolIds: [] });
    expect(bound.config).not.toHaveProperty('connectionId');
    expect(bound.config).not.toHaveProperty('modelName');
    expect(bound.capabilities).toEqual([]);
    const flow = { id: 'flow', revision: 1, name: 'Remote', edges: [], createdAt: 0, digest: '', nodes: [{ ...node, ...bound }] };
    const admitted = await prepareFlowConnections(flow as never, {}, service);
    expect(admitted.connections).toEqual([]);
    expect(service.getConnection).not.toHaveBeenCalled();
    const graph = { nodes: admitted.nodes, edges: [] };
    connection.project = { root: '/changed' };
    await expect(validatePlannedFlowConnections(graph as never, flow as never, service)).rejects.toThrow('changed after admission');
});

it('accepts inline harness targets before their snapshot is admitted', async () => {
    const { resolver, service, connection } = fixture();
    const node = { id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
        config: { execution: { kind: 'harness', connectionId: 'remote' }, instruction: 'Review' } };
    const bound = await bindStandaloneFlowNode(node as never, undefined, 'session', resolver);
    const admitted = await prepareFlowConnections({ nodes: [{ ...node, ...bound }], edges: [] } as never, {}, service);
    expect(admitted.nodes[0].config).toMatchObject({ execution: node.config.execution, harnessConnection: connection });
});

it('rejects legacy subtasks on a remote Agent before they can materialize local children', async () => {
    const { resolver } = fixture();
    const node = { id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
        config: { agentId: 'reviewer', subtasks: { template: { config: { connectionId: 'local-model' } } } } };
    await expect(bindStandaloneFlowNode(node as never, undefined, 'session', resolver)).rejects.toThrow('cannot host local delegation');
});

it('admits a dynamic inline remote target and rejects changes to its saved binding', async () => {
    const { resolver, connection } = fixture();
    const identities = frozenFlowIdentities({ agents: [], skills: [], prompts: [], mcp: [] }, resolver);
    const node = { id: 'dynamic', name: 'Dynamic', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
        config: { execution: { kind: 'harness', connectionId: 'remote' }, instruction: 'Review' } };
    const bound = await bindStandaloneFlowNode(node as never, undefined, 'session', identities);
    expect(bound.config).toMatchObject({ harnessConnection: connection });
    connection.project = { root: '/changed' };
    await expect(bindStandaloneFlowNode({ ...node, ...bound } as never, undefined, 'session', identities)).rejects.toThrow('changed after admission');
});

it('revalidates remote delegation candidates independently from a local parent', async () => {
    const { resolver, service, connection } = fixture();
    const node = { id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
        config: { delegation: { enabled: true, agents: [{ agentId: 'reviewer' }] } } };
    const bound = await bindStandaloneFlowNode(node as never, undefined, 'session', resolver);
    const admitted = await prepareFlowConnections({ nodes: [{ ...node, ...bound }], edges: [] } as never, {}, service);
    expect(admitted.nodes[0].config).toMatchObject({ delegation: { resolvedTemplates: { reviewer: { config: {
        execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: connection } } } } });
    connection.enabled = false;
    await expect(prepareFlowConnections(admitted, {}, service)).rejects.toThrow('unavailable or unauthorized');
});

it('prepares direct remote execution without acquiring local tools and requires host-prepared attachments', async () => {
    const { resolver } = fixture(), config = await resolver.resolveExact('reviewer');
    const execution = { config, roundId: 'round', task: { sessionId: 'session', input: { text: 'Review', files: [] } } };
    const options = { resolveHarnessToolIds: vi.fn(), resolveMCPToolIds: vi.fn(), resolveSkills: vi.fn() };
    await prepareDirectConversation(options as never, execution as never);
    expect(options.resolveHarnessToolIds).not.toHaveBeenCalled();
    expect(options.resolveMCPToolIds).not.toHaveBeenCalled();
    expect(options.resolveSkills).not.toHaveBeenCalled();
    const snapshot = { canonicalMessages: [{ role: 'user', content: 'Review' }] };
    const build = (value: unknown) => directTaskSpec(value as never, snapshot as never, { definitions: [], externalIds: [] }, [], {} as never);
    expect(build(execution)).toMatchObject({ program: { kind: 'kernel-adapters.harness', version: '1' },
        input: { connection: config.harnessConnection, messages: snapshot.canonicalMessages }, deferStart: true });
    expect(() => build({ ...execution, task: { ...execution.task, input: { files: [{ name: 'image' }] } } })).toThrow('HARNESS_CURRENT_INPUT_REQUIRED');
});

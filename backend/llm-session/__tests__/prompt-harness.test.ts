import {expect, it, vi} from 'vitest';
import {createFlowRevision} from '@itookit/llm-flow';
import type {FlowDraft} from '@itookit/llm-flow/contracts';
import type {HarnessConnectionSnapshot} from '@itookit/kernel-adapters/contracts';
import {AgentResolver} from '../src/session/agent-resolver';
import {SessionRunCoordinator} from '../src/session/session-run-coordinator';
import {prepareDirectConversation, directTaskSpec} from '../src/session/direct-conversation';
import {bindFlowNode} from '../src/session/flow-node-binder';
import {promptHarnessFlow} from '../src/contracts/prompt-harness-flow';
import {prepareFlowAgentInput} from '../src/session/flow-agent';
import {mergeSessionSettings} from '../src/persistence/session-settings';
import {DEFAULT_SESSION_SETTINGS} from '../src/contracts/chat';

const connection: HarnessConnectionSnapshot = {version: 1, revision: 1, id: 'chosen', name: 'Chosen', kind: 'harness',
    nodeConnectionId: 'node', projectId: 'project', profileId: 'codex', project: {root: '/workspace'}};
function fixture() {
    const definition = {id: 'writer', name: 'Writer', type: 'agent', version: '1', config: {}, systemPrompt: 'PRIVATE_INSTRUCTION',
        capabilityPolicy: {toolIds: ['private-tool'], skillIds: ['private-skill'], mcpProfileIds: ['private-mcp']}};
    const service = {getAgentConfig: vi.fn(async () => definition), getHarnessConnection: vi.fn(async () => connection),
        getConnection: vi.fn(async () => {throw new Error('No local model allowed');}), getProvider: vi.fn(),
        getDefaultConnection: vi.fn(), getModelDefaults: vi.fn(async () => ({})), getSkills: vi.fn(async () => [])};
    const resolver = new AgentResolver(service as never);
    const coordinator = new SessionRunCoordinator(...[{getSessionSettings: async () => ({harnessConnectionId: connection.id})}, {}, resolver,
        ...Array(5).fill({})] as ConstructorParameters<typeof SessionRunCoordinator>);
    return {definition, service, resolver, coordinator};
}
it('freezes prompt identity on the chosen harness and never resolves local tools', async () => {
    const f = fixture(), item = {id: 'operation', agentId: 'writer', text: 'PRIVATE_INPUT', files: [], branch: 'main', createdAt: 0, state: 'pending'};
    const admitted = await f.coordinator.bindQueuedInstruction('session', item as never);
    const config = admitted.connectionBinding.harnessAgent!;
    expect(config).toMatchObject({systemPrompt: ['PRIVATE_INSTRUCTION'], execution: {kind: 'harness', connectionId: 'chosen'}});
    expect(config.capabilityPolicy).toBeUndefined(); expect(config.memoryPolicy).toBeUndefined();
    const ports = {resolveHarnessToolIds: vi.fn(), resolveMCPToolIds: vi.fn(), resolveSkills: vi.fn()};
    const execution = {config, roundId: 'r', task: {sessionId: 'session', input: {...item, sessionId: 'session'}}};
    await prepareDirectConversation(ports, execution as never);
    for (const method of Object.values(ports)) expect(method).not.toHaveBeenCalled();
    const messages = [{role: 'system', content: 'PRIVATE_INSTRUCTION'}, {role: 'user', content: 'PRIVATE_INPUT'}];
    const task = directTaskSpec(execution as never, {canonicalMessages: messages} as never, {definitions: [], externalIds: []}, [], {} as never);
    expect(task).toMatchObject({program: {kind: 'kernel-adapters.harness'}, input: {messages, connection}});
    expect(JSON.stringify(task)).not.toMatch(/private-tool|private-skill|private-mcp/);
    expect(f.service.getConnection).not.toHaveBeenCalled();
});
it('rebinds Flow Agent nodes while keeping graph edges, prompts and explicit Tool nodes', async () => {
    const f = fixture(), original = createFlowRevision({id: 'flow', name: 'Flow', draftVersion: 1, updatedAt: 0,
        connections: [{name: 'llm', required: true}], parameters: [], nodes: [
            {id: 'write', name: 'Write', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {agentId: 'writer', instruction: 'Write', connectionSlot: 'llm'}},
        ], edges: []} as unknown as FlowDraft, 1);
    const runtime = promptHarnessFlow(original, connection.id);
    expect(runtime.connections).toEqual([]); expect(runtime.nodes[0].config).not.toHaveProperty('connectionSlot');
    expect(original.nodes[0].config).toHaveProperty('connectionSlot', 'llm');
    const getSkills = vi.fn(async () => {throw new Error('No local skills allowed');});
    const bound = await bindFlowNode(runtime.nodes[0] as never, undefined, {blocks: [], canonicalMessages: []},
        {sessionId: 'session', input: {text: 'Input', instructionConnectionBinding: {defaults: {}, harnessConnection: connection}}} as never,
        {roundId: 'r', config: {id: 'flow', name: 'Flow', type: 'flow'}} as never, {...f.resolver, resolveExact: id => f.resolver.resolveExact(id),
            getSkills, getSystemPrompt: async () => null, resolveHarnessConnection: (id, saved) => f.resolver.resolveHarnessConnection(id, saved)});
    expect(bound).toMatchObject({capabilities: [], config: {execution: {kind: 'harness', connectionId: 'chosen'}, toolIds: []}});
    expect(getSkills).not.toHaveBeenCalled(); expect(f.service.getConnection).not.toHaveBeenCalled();
});
it('prepares and persists a Flow plan without requiring its old model slot', async () => {
    const f = fixture(), definition = createFlowRevision({id: 'flow', name: 'Flow', draftVersion: 1, updatedAt: 0, parameters: [],
        connections: [{name: 'llm', required: true}], nodes: [{id: 'one', name: 'One', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: {agentId: 'writer', instruction: 'Write', connectionSlot: 'llm'}}], edges: []} as unknown as FlowDraft, 1);
    const prepared = await prepareFlowAgentInput({sessionId: 'session', agentId: 'flow', text: '', files: [], target: {kind: 'flow', id: 'flow', version: '1'},
        instructionConnectionBinding: {defaults: {}, harnessConnection: connection}} as never, {definitions: {loadRevision: async () => definition},
        resolveAgent: async () => {throw new Error('No synthetic Flow Agent');}, identityResolver: f.resolver,
        connectionCatalog: f.service, prepareConnections: async flow => flow, host: {logger: {info: vi.fn(), warn: vi.fn()} as never}});
    expect(prepared.instructionFlowBinding?.plan?.graph.nodes[0].config).toMatchObject({execution: {kind: 'harness', connectionId: 'chosen'}, harnessConnection: connection});
    expect(f.service.getConnection).not.toHaveBeenCalled();
});
it('keeps the Session executor fixed across preference saves', () => {
    expect(() => mergeSessionSettings({...DEFAULT_SESSION_SETTINGS, harnessConnectionId: 'chosen'}, {harnessConnectionId: 'other'}))
        .toThrow('fixed for this Session');
});

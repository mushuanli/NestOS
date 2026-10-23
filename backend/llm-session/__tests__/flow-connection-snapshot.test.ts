import { expect, it } from 'vitest';
import { createFlowRevision } from '@itookit/llm-flow';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import { captureFlowConnections, frozenFlowConnections, isFlowConnectionSnapshot } from '../src/session/flow-connection-snapshot';
import { prepareFlowConnections } from '../src/session/flow-connections';
import { prepareFlowAgentInput } from '../src/session/flow-agent';

function fixture() {
    const provider: LLMProvider = { id: 'p', name: 'P', baseURL: 'https://example.test', implementation: 'openai-compatible',
        media: { 'image.generate': { adapter: 'openai-images' } }, apiKey: 'PRIVATE-PROVIDER-KEY', models: [
            { id: 'a', name: 'A', supportsVision: true }, { id: 'b', name: 'B' },
            { id: 'image-a', name: 'IA', operations: { 'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] } } },
            { id: 'image-b', name: 'IB', operations: { 'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] } } },
        ] };
    const connection: ConnectionMeta = { id: 'c', name: 'C', providerId: 'p', model: 'a', tiers: { optimal: 'a' },
        protocol: 'openai-chat', enabled: true, hasApiKey: true, metadata: { private: 'PRIVATE-METADATA' } };
    const catalog = { getConnection: async () => connection, getProvider: () => provider };
    const definition = createFlowRevision({ id: 'f', name: 'F', draftVersion: 1, updatedAt: 0, edges: [],
        connections: [{ name: 'model', connectionId: 'c' }], nodes: [{ id: 'agent', name: 'Agent',
            plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: { connectionSlot: 'model' } }] } as FlowDraft, 1);
    return { provider, connection, catalog, definition };
}

it('freezes model selection without persisting credentials, user metadata or unused connections', async () => {
    const { catalog, definition, connection } = fixture(), capture = captureFlowConnections(catalog);
    await prepareFlowConnections(definition, {}, capture.catalog);
    const snapshot = capture.snapshot();
    expect(isFlowConnectionSnapshot(snapshot)).toBe(true);
    expect(snapshot.connections).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-');
    connection.model = 'b'; connection.tiers!.optimal = 'b';
    const replay = await prepareFlowConnections(definition, {}, frozenFlowConnections(catalog, structuredClone(snapshot)));
    expect(replay.connections![0].resolved!.modelId).toBe('a');
    await expect(frozenFlowConnections(catalog, snapshot).getConnection('never-admitted')).rejects.toMatchObject({ code: 'FLOW_CONNECTION_NOT_ADMITTED' });
});

it.each(['provider', 'protocol', 'endpoint', 'disabled', 'credentials', 'model-removed'] as const)('rejects incompatible live catalog changes: %s', async change => {
    const { catalog, definition, connection, provider } = fixture(), capture = captureFlowConnections(catalog);
    await prepareFlowConnections(definition, {}, capture.catalog);
    const frozen = frozenFlowConnections(catalog, capture.snapshot());
    if (change === 'provider') connection.providerId = 'another-provider';
    if (change === 'protocol') connection.protocol = 'anthropic-messages';
    if (change === 'endpoint') provider.baseURL = 'https://changed.test';
    if (change === 'disabled') connection.enabled = false;
    if (change === 'credentials') connection.hasApiKey = false;
    if (change === 'model-removed') provider.models = provider.models.filter(model => model.id !== 'a');
    await expect(prepareFlowConnections(definition, {}, frozen)).rejects.toMatchObject(change === 'model-removed'
        ? { message: expect.stringContaining('Unknown model') } : { code: `FLOW_CONNECTION_${['provider', 'protocol', 'endpoint'].includes(change) ? 'CHANGED' : 'UNAVAILABLE'}` });
});

it('does not choose a different media tier when the admitted model loses capabilities', async () => {
    const { catalog, definition, connection, provider } = fixture();
    connection.model = 'image-a'; connection.tiers = { optimal: 'image-a', standard: 'image-b' };
    definition.nodes = [{ ...definition.nodes[0], plugin: 'builtin.media', config: { operation: 'image.generate',
        connectionSlot: 'model', request: { prompt: 'Square', format: 'png' } } }];
    const capture = captureFlowConnections(catalog);
    expect((await prepareFlowConnections(definition, {}, capture.catalog)).nodes[0].config).toMatchObject({ modelName: 'image-a' });
    delete provider.models.find(model => model.id === 'image-a')!.operations;
    await expect(prepareFlowConnections(definition, {}, frozenFlowConnections(catalog, capture.snapshot()))).rejects.toThrow();
});

it('rejects a changed media adapter even when baseURL and model are unchanged', async () => {
    const { catalog, definition, connection, provider } = fixture();
    connection.model = 'image-a'; connection.tiers = { optimal: 'image-a' };
    definition.nodes = [{ ...definition.nodes[0], plugin: 'builtin.media', config: { operation: 'image.generate',
        connectionSlot: 'model', request: { prompt: 'Square', format: 'png' } } }];
    const capture = captureFlowConnections(catalog);
    await prepareFlowConnections(definition, {}, capture.catalog);
    provider.media!['image.generate'] = { adapter: 'gemini-image' } as never;
    await expect(prepareFlowConnections(definition, {}, frozenFlowConnections(catalog, capture.snapshot()))).rejects.toThrow();
});

it('uses media purpose defaults instead of treating a queued chat fallback as an explicit override', async () => {
    const { catalog, definition, connection } = fixture();
    definition.connections = [];
    definition.nodes = [{ ...definition.nodes[0], plugin: 'builtin.media', config: { operation: 'image.generate', request: { prompt: 'Square', format: 'png' } } }];
    const connections = { ...catalog, getConnection: async (id: string) => ({ ...connection, id,
        model: id === 'pictures' ? 'image-a' : 'a', tiers: { optimal: id === 'pictures' ? 'image-a' : 'a' } }) };
    const input = { sessionId: 's', text: '', files: [], agentId: 'agent', instructionConnectionBinding: {
        connectionId: 'chat', defaults: { chat: 'chat', 'image.generate': 'pictures' } } };
    const prepared = await prepareFlowAgentInput(input, { definitions: { loadRevision: async () => definition },
        resolveAgent: async () => ({ id: 'agent', name: 'Agent', type: 'agent', agentVersion: 'v1', execution: { kind: 'flow', flowId: 'f' } }),
        connectionCatalog: connections, prepareConnections: async flow => flow, host: { logger: { info() {}, warn() {} } as never } });
    expect(prepared.instructionFlowBinding!.connections!.connections.map(item => item.id)).toEqual(['pictures']);
});

it('fails closed for malformed snapshots and unexpected fields', () => {
    for (const invalid of [null, {}, { connections: [null] }, { connections: [], apiKey: 'PRIVATE' },
        { connections: [{ id: 'x', providerId: 'p', model: 'm', baseURL: '', operationModels: {}, mediaEndpoints: {}, apiKey: 'PRIVATE' }] },
        { connections: [{ id: 'x', providerId: 'p', model: 'm', baseURL: '', operationModels: {}, mediaEndpoints: {}, modelProtocols: { m: 'unknown' } }] }]) {
        expect(isFlowConnectionSnapshot(invalid)).toBe(false);
        expect(() => frozenFlowConnections(fixture().catalog, invalid as never)).toThrowError(expect.objectContaining({ code: 'FLOW_CONNECTION_INVALID_SNAPSHOT' }));
    }
});

it('admits inherited protocols without rewriting the connection and freezes each selected tier separately', async () => {
    const { catalog, definition, connection, provider } = fixture();
    delete connection.protocol;
    provider.defaultProtocol = 'openai-chat';
    provider.models.find(model => model.id === 'b')!.preferredProtocol = 'anthropic-messages';
    connection.tiers = { optimal: 'a', fast: 'b' };
    definition.connections!.push({ name: 'fast', connectionId: 'c', tier: 'fast' });
    definition.nodes.push({ ...definition.nodes[0], id: 'fast' as never, config: { connectionSlot: 'fast' } });
    const capture = captureFlowConnections(catalog);
    const admitted = await prepareFlowConnections(definition, {}, capture.catalog);
    expect(admitted.connections!.map(slot => slot.resolved)).toMatchObject([
        { modelId: 'a', protocol: 'openai-chat' }, { modelId: 'b', protocol: 'anthropic-messages' },
    ]);
    expect(connection.protocol).toBeUndefined();
    const snapshot = JSON.parse(JSON.stringify(capture.snapshot()));
    expect(snapshot.connections[0].modelProtocols).toEqual({ a: 'openai-chat', b: 'anthropic-messages' });
    expect(isFlowConnectionSnapshot(snapshot)).toBe(true);
    await expect(prepareFlowConnections(admitted, {}, frozenFlowConnections(catalog, snapshot))).resolves.toMatchObject({ connections: admitted.connections });
    provider.models.find(model => model.id === 'b')!.preferredProtocol = 'openai-responses';
    await expect(prepareFlowConnections(admitted, {}, frozenFlowConnections(catalog, snapshot)))
        .rejects.toMatchObject({ code: 'FLOW_CONNECTION_CHANGED' });
});

it('rejects inherited Provider protocol drift and unknown capabilities before dispatch', async () => {
    const { catalog, definition, connection, provider } = fixture();
    delete connection.protocol;
    await expect(prepareFlowConnections(definition, {}, catalog)).rejects.toThrow('protocol capability is unknown');
    provider.defaultProtocol = 'anthropic-messages';
    const capture = captureFlowConnections(catalog), admitted = await prepareFlowConnections(definition, {}, capture.catalog);
    expect(admitted.connections![0].resolved!.protocol).toBe('anthropic-messages');
    const snapshot = capture.snapshot();
    provider.defaultProtocol = 'openai-chat';
    await expect(prepareFlowConnections(definition, {}, frozenFlowConnections(catalog, snapshot)))
        .rejects.toMatchObject({ code: 'FLOW_CONNECTION_CHANGED' });
});

it('freezes inherited protocols for direct model overrides and keeps explicit protocol priority', async () => {
    const { catalog, definition, connection, provider } = fixture();
    delete connection.protocol;
    provider.defaultProtocol = 'openai-chat';
    provider.models.find(model => model.id === 'b')!.preferredProtocol = 'anthropic-messages';
    definition.connections = [];
    definition.nodes[0].config = { connectionId: 'c', modelName: 'b' };
    const capture = captureFlowConnections(catalog), admitted = await prepareFlowConnections(definition, {}, capture.catalog);
    expect(admitted.nodes[0].config).toMatchObject({ modelName: 'b', frozenConnection: { modelId: 'b', protocol: 'anthropic-messages' } });
    const snapshot = capture.snapshot();
    provider.models.find(model => model.id === 'b')!.preferredProtocol = 'openai-responses';
    await expect(prepareFlowConnections(admitted, {}, frozenFlowConnections(catalog, snapshot))).rejects.toMatchObject({ code: 'FLOW_CONNECTION_CHANGED' });
    connection.protocol = 'openai-chat';
    const explicit = captureFlowConnections(catalog), explicitPlan = await prepareFlowConnections(definition, {}, explicit.catalog);
    provider.defaultProtocol = 'gemini-generate';
    provider.models.find(model => model.id === 'b')!.preferredProtocol = 'gemini-generate';
    await expect(prepareFlowConnections(explicitPlan, {}, frozenFlowConnections(catalog, explicit.snapshot())))
        .resolves.toMatchObject({ nodes: [{ config: { frozenConnection: { protocol: 'openai-chat' } } }] });
});

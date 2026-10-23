import { resolveModelProtocol, validateMediaRequest, type MediaGenerationRequest } from '@itookit/driver-llm/contracts';
import type { FlowRevision, FlowConnection, JsonValue } from '@itookit/llm-flow/contracts';
import { assertModelConnection, isModelOperation, modelForOperation, mediaEndpointIdentity, type ModelRequirements, type ModelOperation } from '@itookit/kernel-adapters/contracts';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import type { IAgentConfigService } from '../contracts';
import { inferFlowConnectionRequirements, nodeRequirements, nodeSlot } from '../contracts/flow-connection-policy';
import { resolveNodeConnection as resolveFlowNodeConnection } from '@itookit/llm-flow';
import { DELEGATION_LIMITS } from '@itookit/llm-flow/contracts';
import { admitHarnessConnection, type HarnessConnectionCatalog } from './harness-binding';
export type FlowConnectionCatalog = Pick<IAgentConfigService, 'getConnection' | 'getProvider'> & Partial<Pick<IAgentConfigService, 'getDefaultConnection' | 'getModelDefaults'>> & HarnessConnectionCatalog & {
    operationModelId?(connectionId: string, operation: ModelOperation): string | undefined;
    assertOperationIdentity?(connection: ConnectionMeta, provider: LLMProvider, operation: ModelOperation, modelId: string): void;
};
/** Resolve each named slot independently; snapshots never contain credentials. */
export async function prepareFlowConnections(flow: FlowRevision, bindings: Record<string, string> = {}, agents: FlowConnectionCatalog,
    frozenDefaults?: import('@itookit/kernel-adapters/contracts').ModelDefaults, runConnectionId?: string, parameters?: Record<string, JsonValue>): Promise<FlowRevision> {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('Invalid connection bindings');
    const defaults = frozenDefaults ?? await agents.getModelDefaults?.() ?? {};
    const catalog = agents;
    agents = { getConnection: id => catalog.getConnection(id), getProvider: id => catalog.getProvider(id), getModelDefaults: async () => defaults,
        ...(catalog.getHarnessConnection ? { getHarnessConnection: (id: string) => catalog.getHarnessConnection!(id) } : {}),
        ...(catalog.operationModelId ? { operationModelId: (id, operation) => catalog.operationModelId!(id, operation) } : {}),
        ...(catalog.assertOperationIdentity ? { assertOperationIdentity: (connection, provider, operation, modelId) => catalog.assertOperationIdentity!(connection, provider, operation, modelId) } : {}) };
    const slots = inferFlowConnectionRequirements(flow, parameters);
    for (const [name, id] of Object.entries(bindings)) {
        const nested = flow.nodes.some(node => node.plugin === 'builtin.flow' && name.startsWith(node.id + '/'));
        const slot = slots.find(slot => slot.name === name);
        if ((!slot && !nested) || typeof id !== 'string' || (id !== '' && !id.trim())
            || (id === '' && !nested && slot?.required !== false)) throw Object.assign(new Error(`Invalid connection slot binding: ${name}`), {code: 'FLOW_CONNECTION_BINDING_INVALID', field: name});
    }
    const connections = await Promise.all(slots.map(slot => admitFlowConnectionSlot(slot, bindings[slot.name] ?? slot.connectionId, agents)));
    const nodes = await Promise.all(flow.nodes.map(async node => {
        let config = record(node.config);
        if (node.plugin === 'builtin.media') return prepareMediaNode(node, config, connections, agents, runConnectionId);
        if (node.plugin !== 'builtin.agent') return node;
        config = await prepareDelegationConnections(config, connections, flow.defaultConnection, agents, runConnectionId);
        if (record(config.execution).kind === 'harness') return { ...node, config: await prepareHarnessConnection(config, agents) };
        const requirements = nodeRequirements('chat', config, nodeSlot(node, slots));
        if (config.connectionSlot || typeof config.connectionId !== 'string' || slots.some(slot => slot.name === config.connectionId))
            return { ...node, config: { ...config, connectionRequirements: requirements } };
        const resolved = await resolveNodeConnection({ ...config, connectionRequirements: requirements }, agents);
        return { ...node, config: { ...config, connectionRequirements: requirements, modelName: resolved.modelId, frozenConnection: resolved } };
    }));
    return { ...flow, connections, nodes };
}

async function prepareDelegationConnections(config: Record<string, JsonValue>, connections: FlowConnection[],
    defaultConnection: string | undefined, agents: FlowConnectionCatalog, runConnectionId?: string, depth = 0): Promise<Record<string, JsonValue>> {
    const delegation = record(config.delegation);
    if (!delegation.resolvedTemplate && !delegation.resolvedTemplates) return config;
    if (depth >= DELEGATION_LIMITS.maxDepth) throw new Error('Delegation connection nesting exceeds the supported depth');
    const prepare = (value: JsonValue) => prepareDelegationTemplate(record(value), connections, defaultConnection, agents, runConnectionId, depth + 1);
    const resolvedTemplate = !Array.isArray(delegation.agents) && delegation.resolvedTemplate ? await prepare(delegation.resolvedTemplate) : undefined;
    const resolvedTemplates = delegation.resolvedTemplates ? Object.fromEntries(await Promise.all(Object.entries(record(delegation.resolvedTemplates))
        .map(async ([id, value]) => [id, await prepare(value)]))) : undefined;
    const prepared = { ...delegation, ...(resolvedTemplate ? { resolvedTemplate } : {}), ...(resolvedTemplates ? { resolvedTemplates } : {}) };
    if (Array.isArray(delegation.agents)) delete prepared.resolvedTemplate;
    return { ...config, delegation: prepared };
}

async function prepareDelegationTemplate(template: Record<string, JsonValue>, connections: FlowConnection[],
    defaultConnection: string | undefined, agents: FlowConnectionCatalog, runConnectionId: string | undefined, depth: number): Promise<Record<string, JsonValue>> {
    let config = structuredClone(record(template.config));
    if (record(config.execution).kind === 'harness') return { ...template, config: await prepareHarnessConnection(config, agents) };
    const requirements = nodeRequirements('chat', config, nodeSlot({ config } as FlowRevision['nodes'][number], connections));
    resolveFlowNodeConnection(config, connections, defaultConnection, (await agents.getModelDefaults?.())?.chat, runConnectionId);
    config = await prepareDelegationConnections(config, connections, defaultConnection, agents, runConnectionId, depth);
    if (!config.connectionId) return { ...template, config: { ...config, connectionRequirements: requirements } };
    const resolved = await resolveNodeConnection({ ...config, connectionRequirements: requirements }, agents);
    return { ...template, config: { ...config, connectionRequirements: requirements, modelName: resolved.modelId, frozenConnection: resolved } };
}
async function prepareHarnessConnection(config: Record<string, JsonValue>, agents: FlowConnectionCatalog): Promise<Record<string, JsonValue>> {
    const execution = record(config.execution);
    if (typeof execution.connectionId !== 'string' || !execution.connectionId) throw new Error('Harness connection identity is required');
    const snapshot = await admitHarnessConnection(agents, execution.connectionId,
        config.harnessConnection as unknown as import('@itookit/kernel-adapters/contracts').HarnessConnectionSnapshot | undefined);
    return { ...config, harnessConnection: JSON.parse(JSON.stringify(snapshot)) as JsonValue };
}
export async function admitFlowConnectionSlot(slot: FlowConnection, connectionId: string | undefined, agents: FlowConnectionCatalog): Promise<FlowConnection> {
    const operation = slot.requirements?.operation ?? 'chat';
    const fallback = connectionId === undefined && slot.required !== false && !slot.resolved && isModelOperation(operation)
        ? (await agents.getModelDefaults?.())?.[operation] : undefined;
    connectionId ??= fallback;
    if (!connectionId) { if (slot.required === false) return { ...slot, connectionId: undefined, resolved: undefined }; throw Object.assign(new Error(`Missing connection binding: ${slot.name}`), {code: 'FLOW_CONNECTION_BINDING_MISSING', field: slot.name}); }
    const connection = await agents.getConnection(connectionId), provider = connection && agents.getProvider(connection.providerId);
    const defaultModel = connection && !slot.tier && operation !== 'chat' && isModelOperation(operation) ? operationModelId(connection, provider, operation, agents) : undefined;
    const modelId = slot.resolved?.modelId ?? defaultModel ?? connection?.tiers?.[slot.tier ?? 'optimal'] ?? connection?.model ?? '';
    try { assertConnection(connection, provider, modelId, slot.requirements);
        if (isModelOperation(operation)) agents.assertOperationIdentity?.(connection!, provider!, operation, modelId); }
    catch (error) { throw Object.assign(new Error(`Connection slot ${slot.name}: ${error instanceof Error ? error.message : 'Connection validation failed'}`, {cause: error}),
        { code: connectionErrorCode(error), field: slot.name }); }
    const protocol = operation === 'chat' ? resolveModelProtocol(connection!, provider, modelId) : connection!.protocol;
    if (slot.resolved && (slot.resolved.providerId !== connection!.providerId || slot.resolved.protocol !== protocol)) throw new Error(`Connection changed after admission: ${slot.name}`);
    const mediaEndpoint = mediaEndpointIdentity(provider!, connection!.baseURL, slot.requirements?.operation ?? 'chat');
    if (slot.resolved?.mediaEndpoint && slot.resolved.mediaEndpoint !== mediaEndpoint) throw new Error('Media endpoint changed after admission');
    return { ...slot, connectionId, resolved: { providerId: connection!.providerId, modelId, ...(protocol ? { protocol } : {}), ...(mediaEndpoint ? { mediaEndpoint } : {}) } };
}
async function resolveNodeConnection(config: Record<string, JsonValue>, agents: FlowConnectionCatalog) {
    const connection = await agents.getConnection(String(config.connectionId)), provider = connection && agents.getProvider(connection.providerId);
    const requirements = config.connectionRequirements as unknown as ModelRequirements | undefined;
    const operation = requirements?.operation;
    const selected = connection && isModelOperation(operation) ? operationModelId(connection, provider, operation, agents) : undefined;
    const modelId = typeof config.modelName === 'string' ? config.modelName : selected ?? connection?.tiers?.optimal ?? connection?.model ?? '';
    assertConnection(connection, provider, modelId, requirements);
    if (isModelOperation(operation)) agents.assertOperationIdentity?.(connection!, provider!, operation, modelId);
    const mediaEndpoint = mediaEndpointIdentity(provider!, connection!.baseURL, requirements?.operation ?? 'chat'), saved = config.frozenConnection;
    const protocol = !operation || operation === 'chat' ? resolveModelProtocol(connection!, provider, modelId) : connection!.protocol;
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && (saved.providerId !== connection!.providerId || saved.protocol !== protocol || saved.modelId !== modelId || saved.mediaEndpoint !== mediaEndpoint)) throw new Error('Node connection changed after admission');
    return { providerId: connection!.providerId, modelId, ...(mediaEndpoint ? { mediaEndpoint } : {}), ...(protocol ? { protocol } : {}),
        ...(requirements ? { requirements: JSON.parse(JSON.stringify(requirements)) as JsonValue } : {}) };
}
async function prepareMediaNode(node: FlowRevision['nodes'][number], config: Record<string, JsonValue>, slots: FlowConnection[], agents: FlowConnectionCatalog, runConnectionId?: string): Promise<FlowRevision['nodes'][number]> {
    if (config.operation !== 'image.generate' && config.operation !== 'speech.synthesize') throw new Error('Unsupported media operation');
    const slotName = typeof config.connectionSlot === 'string' ? config.connectionSlot : slots.find(slot => slot.name === config.connectionId)?.name;
    const slot = slots.find(item => item.name === slotName);
    if (slotName && !slot) throw new Error(`Unknown media connection slot: ${slotName}`);
    const requirements = nodeRequirements(config.operation, config, slot);
    const runOverride = !slotName && config.connectionId === undefined ? runConnectionId : undefined;
    const fallback = !runOverride && !slotName && config.connectionId === undefined && !config.frozenConnection
        ? (await agents.getModelDefaults?.())?.[config.operation] : undefined;
    const connectionId = slot?.connectionId ?? config.connectionId ?? runOverride ?? fallback;
    if (slot?.required === false && !slot.connectionId) return { ...node, config: { ...config, connectionRequirements: requirements } };
    if (typeof connectionId !== 'string' || !connectionId.trim()) throw new Error('Media node requires an explicit connection or bound slot');
    const defaultConnection = fallback ? await agents.getConnection(fallback) : undefined;
    const defaultModel = defaultConnection && operationModelId(defaultConnection, agents.getProvider(defaultConnection.providerId), config.operation, agents);
    const resolved = await resolveNodeConnection({ ...config, connectionId, connectionRequirements: requirements,
        ...(slot?.resolved ? { modelName: slot.resolved.modelId } : !config.modelName && defaultModel ? { modelName: defaultModel } : {}) }, agents);
    if (config.modelName && config.modelName !== resolved.modelId) throw new Error('Media node model conflicts with slot');
    const connection = await agents.getConnection(connectionId), request = { ...record(config.request), operation: config.operation, model: resolved.modelId };
    if (!JSON.stringify(request).includes('${')) validateMediaRequest(agents.getProvider(connection!.providerId)!, request as MediaGenerationRequest);
    return { ...node, config: { ...config, ...(!slotName && !runOverride ? { connectionId } : {}), connectionRequirements: requirements, modelName: resolved.modelId, frozenConnection: resolved } };
}
function operationModelId(connection: ConnectionMeta, provider: LLMProvider | undefined, operation: ModelOperation, agents: FlowConnectionCatalog): string | undefined {
    return agents.operationModelId ? agents.operationModelId(connection.id, operation) : modelForOperation(connection, provider, operation)?.id;
}
function assertConnection(...args: Parameters<typeof assertModelConnection>): void {
    try { assertModelConnection(...args); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error('Connection validation failed'), { code: connectionErrorCode(error) }); }
}
function connectionErrorCode(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'MODEL_OUTPUT_FORMAT_UNSUPPORTED') return 'FLOW_CONNECTION_OUTPUT_FORMAT_UNSUPPORTED';
    return typeof code === 'string' && /^FLOW_CONNECTION_[A-Z_]+$/.test(code) ? code : 'FLOW_CONNECTION_INVALID';
}
function record(value: unknown): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }

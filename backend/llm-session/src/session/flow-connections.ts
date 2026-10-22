import { validateMediaRequest, type MediaGenerationRequest } from '@itookit/driver-llm/contracts';
import type { FlowRevision, FlowConnection, JsonValue } from '@itookit/llm-flow/contracts';
import { assertModelConnection, isModelOperation, modelForOperation, mediaEndpointIdentity, type ModelRequirements } from '@itookit/kernel-adapters/contracts';
import type { IAgentConfigService } from '../contracts';
import { inferFlowConnectionRequirements, nodeRequirements, nodeSlot } from '../contracts/flow-connection-policy';
type ConnectionCatalog = Pick<IAgentConfigService, 'getConnection' | 'getProvider'> & Partial<Pick<IAgentConfigService, 'getDefaultConnection' | 'getModelDefaults'>>;
/** Resolve each named slot independently; snapshots never contain credentials. */
export async function prepareFlowConnections(flow: FlowRevision, bindings: Record<string, string> = {}, agents: ConnectionCatalog,
    frozenDefaults?: import('@itookit/kernel-adapters/contracts').ModelDefaults, runConnectionId?: string): Promise<FlowRevision> {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('Invalid connection bindings');
    const defaults = frozenDefaults ?? await agents.getModelDefaults?.() ?? {};
    const catalog = agents;
    agents = { getConnection: id => catalog.getConnection(id), getProvider: id => catalog.getProvider(id), getModelDefaults: async () => defaults };
    const slots = inferFlowConnectionRequirements(flow);
    for (const [name, id] of Object.entries(bindings)) {
        const nested = flow.nodes.some(node => node.plugin === 'builtin.flow' && name.startsWith(node.id + '/'));
        const slot = slots.find(slot => slot.name === name);
        if ((!slot && !nested) || typeof id !== 'string' || (id !== '' && !id.trim())
            || (id === '' && !nested && slot?.required !== false)) throw new Error(`Invalid connection slot binding: ${name}`);
    }
    const connections = await Promise.all(slots.map(slot => resolveSlot(slot, bindings[slot.name] ?? slot.connectionId, agents)));
    const nodes = await Promise.all(flow.nodes.map(async node => {
        const config = record(node.config);
        if (node.plugin === 'builtin.media') return prepareMediaNode(node, config, connections, agents, runConnectionId);
        if (node.plugin !== 'builtin.agent') return node;
        const requirements = nodeRequirements('chat', config, nodeSlot(node, slots));
        if (config.connectionSlot || typeof config.connectionId !== 'string' || slots.some(slot => slot.name === config.connectionId))
            return { ...node, config: { ...config, connectionRequirements: requirements } };
        const resolved = await resolveNodeConnection({ ...config, connectionRequirements: requirements }, agents);
        return { ...node, config: { ...config, connectionRequirements: requirements, modelName: resolved.modelId, frozenConnection: resolved } };
    }));
    return { ...flow, connections, nodes };
}
async function resolveSlot(slot: FlowConnection, connectionId: string | undefined, agents: ConnectionCatalog): Promise<FlowConnection> {
    const operation = slot.requirements?.operation ?? 'chat';
    const fallback = connectionId === undefined && slot.required !== false && !slot.resolved && isModelOperation(operation)
        ? (await agents.getModelDefaults?.())?.[operation] : undefined;
    connectionId ??= fallback;
    if (!connectionId) { if (slot.required === false) return { ...slot, connectionId: undefined, resolved: undefined }; throw new Error(`Missing connection binding: ${slot.name}`); }
    const connection = await agents.getConnection(connectionId), provider = connection && agents.getProvider(connection.providerId);
    const defaultModel = connection && !slot.tier && operation !== 'chat' && isModelOperation(operation) ? modelForOperation(connection, provider, operation)?.id : undefined;
    const modelId = slot.resolved?.modelId ?? defaultModel ?? connection?.tiers?.[slot.tier ?? 'optimal'] ?? connection?.model ?? '';
    try { assertModelConnection(connection, provider, modelId, slot.requirements); }
    catch (error) { throw new Error(`Connection slot ${slot.name}: ${error instanceof Error ? error.message : 'Connection validation failed'}`, {cause: error}); }
    if (slot.resolved && (slot.resolved.providerId !== connection!.providerId || slot.resolved.protocol !== connection!.protocol)) throw new Error(`Connection changed after admission: ${slot.name}`);
    const mediaEndpoint = mediaEndpointIdentity(provider!, connection!.baseURL, slot.requirements?.operation ?? 'chat');
    if (slot.resolved?.mediaEndpoint && slot.resolved.mediaEndpoint !== mediaEndpoint) throw new Error('Media endpoint changed after admission');
    return { ...slot, connectionId, resolved: { providerId: connection!.providerId, modelId, ...(connection!.protocol ? { protocol: connection!.protocol } : {}), ...(mediaEndpoint ? { mediaEndpoint } : {}) } };
}
async function resolveNodeConnection(config: Record<string, JsonValue>, agents: ConnectionCatalog) {
    const connection = await agents.getConnection(String(config.connectionId)), provider = connection && agents.getProvider(connection.providerId);
    const requirements = config.connectionRequirements as unknown as ModelRequirements | undefined;
    const operation = requirements?.operation;
    const selected = connection && isModelOperation(operation) ? modelForOperation(connection, provider, operation)?.id : undefined;
    const modelId = typeof config.modelName === 'string' ? config.modelName : selected ?? connection?.tiers?.optimal ?? connection?.model ?? '';
    assertModelConnection(connection, provider, modelId, requirements);
    const mediaEndpoint = mediaEndpointIdentity(provider!, connection!.baseURL, requirements?.operation ?? 'chat'), saved = config.frozenConnection;
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && (saved.providerId !== connection!.providerId || saved.protocol !== connection!.protocol || saved.modelId !== modelId || saved.mediaEndpoint !== mediaEndpoint)) throw new Error('Node connection changed after admission');
    return { providerId: connection!.providerId, modelId, ...(mediaEndpoint ? { mediaEndpoint } : {}), ...(connection!.protocol ? { protocol: connection!.protocol } : {}),
        ...(requirements ? { requirements: JSON.parse(JSON.stringify(requirements)) as JsonValue } : {}) };
}
async function prepareMediaNode(node: FlowRevision['nodes'][number], config: Record<string, JsonValue>, slots: FlowConnection[], agents: ConnectionCatalog, runConnectionId?: string): Promise<FlowRevision['nodes'][number]> {
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
    const defaultModel = defaultConnection && modelForOperation(defaultConnection, agents.getProvider(defaultConnection.providerId), config.operation)?.id;
    const resolved = await resolveNodeConnection({ ...config, connectionId, connectionRequirements: requirements,
        ...(slot?.resolved ? { modelName: slot.resolved.modelId } : !config.modelName && defaultModel ? { modelName: defaultModel } : {}) }, agents);
    if (config.modelName && config.modelName !== resolved.modelId) throw new Error('Media node model conflicts with slot');
    const connection = await agents.getConnection(connectionId), request = { ...record(config.request), operation: config.operation, model: resolved.modelId };
    if (!JSON.stringify(request).includes('${')) validateMediaRequest(agents.getProvider(connection!.providerId)!, request as MediaGenerationRequest);
    return { ...node, config: { ...config, ...(!slotName && !runOverride ? { connectionId } : {}), connectionRequirements: requirements, modelName: resolved.modelId, frozenConnection: resolved } };
}
function record(value: unknown): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }

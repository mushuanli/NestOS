import { validateMediaRequest, type MediaGenerationRequest } from '@itookit/driver-llm/contracts';
import type { FlowRevision, FlowConnection, JsonValue } from '@itookit/llm-flow/contracts';
import { assertModelConnection, mediaEndpointIdentity, type ModelRequirements } from '@itookit/kernel-adapters/contracts';
import type { IAgentConfigService } from '../contracts';
type ConnectionCatalog = Pick<IAgentConfigService, 'getConnection' | 'getProvider'>;
/** Resolve each named slot independently; snapshots never contain credentials. */
export async function prepareFlowConnections(flow: FlowRevision, bindings: Record<string, string> = {}, agents: ConnectionCatalog): Promise<FlowRevision> {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('Invalid connection bindings');
    const slots = inferConnectionRequirements(flow);
    for (const [name, id] of Object.entries(bindings)) {
        const nested = flow.nodes.some(node => node.plugin === 'builtin.flow' && name.startsWith(node.id + '/'));
        const slot = slots.find(slot => slot.name === name);
        if ((!slot && !nested) || typeof id !== 'string' || (id !== '' && !id.trim())
            || (id === '' && !nested && slot?.required !== false)) throw new Error(`Invalid connection slot binding: ${name}`);
    }
    const connections = await Promise.all(slots.map(slot => resolveSlot(slot, bindings[slot.name] ?? slot.connectionId, agents)));
    const nodes = await Promise.all(flow.nodes.map(async node => {
        const config = record(node.config);
        if (node.plugin === 'builtin.media') return prepareMediaNode(node, config, connections, agents);
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
    if (!connectionId) { if (slot.required === false) return { ...slot, connectionId: undefined, resolved: undefined }; throw new Error(`Missing connection binding: ${slot.name}`); }
    const connection = await agents.getConnection(connectionId), provider = connection && agents.getProvider(connection.providerId);
    const modelId = slot.resolved?.modelId ?? connection?.tiers?.[slot.tier ?? 'optimal'] ?? connection?.model ?? '';
    assertModelConnection(connection, provider, modelId, slot.requirements);
    if (slot.resolved && (slot.resolved.providerId !== connection!.providerId || slot.resolved.protocol !== connection!.protocol)) throw new Error(`Connection changed after admission: ${slot.name}`);
    const mediaEndpoint = mediaEndpointIdentity(provider!, connection!.baseURL, slot.requirements?.operation ?? 'chat');
    if (slot.resolved?.mediaEndpoint && slot.resolved.mediaEndpoint !== mediaEndpoint) throw new Error('Media endpoint changed after admission');
    return { ...slot, connectionId, resolved: { providerId: connection!.providerId, modelId, ...(connection!.protocol ? { protocol: connection!.protocol } : {}), ...(mediaEndpoint ? { mediaEndpoint } : {}) } };
}
async function resolveNodeConnection(config: Record<string, JsonValue>, agents: ConnectionCatalog) {
    const connection = await agents.getConnection(String(config.connectionId)), provider = connection && agents.getProvider(connection.providerId);
    const modelId = typeof config.modelName === 'string' ? config.modelName : connection?.tiers?.optimal ?? connection?.model ?? '';
    const requirements = config.connectionRequirements as unknown as ModelRequirements | undefined;
    assertModelConnection(connection, provider, modelId, requirements);
    const mediaEndpoint = mediaEndpointIdentity(provider!, connection!.baseURL, requirements?.operation ?? 'chat'), saved = config.frozenConnection;
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && (saved.providerId !== connection!.providerId || saved.protocol !== connection!.protocol || saved.modelId !== modelId || saved.mediaEndpoint !== mediaEndpoint)) throw new Error('Node connection changed after admission');
    return { providerId: connection!.providerId, modelId, ...(mediaEndpoint ? { mediaEndpoint } : {}), ...(connection!.protocol ? { protocol: connection!.protocol } : {}),
        ...(requirements ? { requirements: JSON.parse(JSON.stringify(requirements)) as JsonValue } : {}) };
}
async function prepareMediaNode(node: FlowRevision['nodes'][number], config: Record<string, JsonValue>, slots: FlowConnection[], agents: ConnectionCatalog): Promise<FlowRevision['nodes'][number]> {
    if (config.operation !== 'image.generate' && config.operation !== 'speech.synthesize') throw new Error('Unsupported media operation');
    const slotName = typeof config.connectionSlot === 'string' ? config.connectionSlot : slots.find(slot => slot.name === config.connectionId)?.name;
    const slot = slots.find(item => item.name === slotName);
    if (slotName && !slot) throw new Error(`Unknown media connection slot: ${slotName}`);
    const requirements = nodeRequirements(config.operation, config, slot), connectionId = slot?.connectionId ?? config.connectionId;
    if (slot?.required === false && !slot.connectionId) return { ...node, config: { ...config, connectionRequirements: requirements } };
    if (typeof connectionId !== 'string' || !connectionId.trim()) throw new Error('Media node requires an explicit connection or bound slot');
    const resolved = await resolveNodeConnection({ ...config, connectionId, connectionRequirements: requirements, ...(slot?.resolved ? { modelName: slot.resolved.modelId } : {}) }, agents);
    if (config.modelName && config.modelName !== resolved.modelId) throw new Error('Media node model conflicts with slot');
    const connection = await agents.getConnection(connectionId), request = { ...record(config.request), operation: config.operation, model: resolved.modelId };
    if (!JSON.stringify(request).includes('${')) validateMediaRequest(agents.getProvider(connection!.providerId)!, request as MediaGenerationRequest);
    return { ...node, config: { ...config, connectionRequirements: requirements, modelName: resolved.modelId, frozenConnection: resolved } };
}
function inferConnectionRequirements(flow: FlowRevision): FlowConnection[] {
    const slots = structuredClone(flow.connections ?? []);
    for (const node of flow.nodes.filter(item => item.plugin === 'builtin.media' || item.plugin === 'builtin.agent')) {
        const config = record(node.config);
        const slot = nodeSlot(node, slots);
        if (!slot) continue;
        slot.requirements = nodeRequirements(node.plugin === 'builtin.agent' ? 'chat' : String(config.operation), config, slot);
    }
    return slots;
}
function nodeSlot(node: FlowRevision['nodes'][number], slots: FlowConnection[]): FlowConnection | undefined {
    const config = record(node.config);
    const name = config.connectionSlot ?? config.connectionId;
    return slots.find(item => item.name === name);
}
function nodeRequirements(operation: string, config: Record<string, JsonValue>, slot?: FlowConnection) {
    const declared = config.connectionRequirements as unknown as ModelRequirements | undefined;
    if (declared && declared.operation !== operation) throw new Error('Node requirements conflict with operation');
    if (slot?.requirements && slot.requirements.operation !== operation) throw new Error('Node operation conflicts with connection slot');
    const output = operation === 'chat' ? 'text' : operation === 'image.generate' ? 'image' : 'audio';
    return { operation, inputModalities: [...new Set(['text', ...declared?.inputModalities ?? [], ...slot?.requirements?.inputModalities ?? []])],
        outputModalities: [...new Set([output, ...declared?.outputModalities ?? [], ...slot?.requirements?.outputModalities ?? []])],
        features: [...new Set([...declared?.features ?? [], ...slot?.requirements?.features ?? []])] };
}
function record(value: unknown): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }

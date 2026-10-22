import { API_PROTOCOLS, type ConnectionMeta, type LLMProvider } from '@itookit/driver-llm/contracts';
import { MODEL_OPERATIONS, hasConnectionCredentials, mediaEndpointIdentity, modelForOperation } from '@itookit/kernel-adapters/contracts';
import type { FlowConnectionCatalog } from './flow-connections';
import type { FlowConnectionSelection, FlowConnectionSnapshot } from '../contracts/flow-connection-snapshot';
export type { FlowConnectionSelection, FlowConnectionSnapshot } from '../contracts/flow-connection-snapshot';

/** Capture the catalog entries actually consulted by the compiler, including nested calls. */
export function captureFlowConnections(live: FlowConnectionCatalog) {
    const entries = new Map<string, FlowConnectionSelection>(), pending = new Map<string, Promise<ConnectionMeta | undefined>>();
    const catalog: FlowConnectionCatalog = { ...catalogPorts(live), getConnection(id) {
        let found = pending.get(id);
        if (!found) {
            found = live.getConnection(id).then(connection => {
                if (connection) entries.set(id, selection(connection, live.getProvider(connection.providerId)));
                return connection && structuredClone(connection);
            });
            pending.set(id, found);
        }
        return found;
    }, operationModelId: (id, operation) => entries.get(id)?.operationModels[operation] };
    return { catalog, snapshot: (): FlowConnectionSnapshot => ({ connections: structuredClone([...entries.values()]) }) };
}

/** Keep admitted choices while checking current credentials, availability and model capabilities. */
export function frozenFlowConnections(live: FlowConnectionCatalog, snapshot: FlowConnectionSnapshot): FlowConnectionCatalog {
    if (!isFlowConnectionSnapshot(snapshot)) throw connectionError('INVALID_SNAPSHOT', 'Invalid frozen Flow connection snapshot');
    const entries = new Map(snapshot.connections.map(entry => [entry.id, structuredClone(entry)]));
    return { ...catalogPorts(live), async getConnection(id) {
        const saved = entries.get(id);
        if (!saved) throw connectionError('NOT_ADMITTED', `Flow connection was not admitted: ${id}`);
        const current = await live.getConnection(id);
        if (!current) throw connectionError('UNAVAILABLE', `Flow connection unavailable: ${id}`);
        if (saved.providerId !== current.providerId || saved.protocol !== current.protocol)
            throw connectionError('CHANGED', `Flow connection changed after admission: ${id}`);
        const provider = live.getProvider(current.providerId);
        if (!provider || current.enabled === false || provider.enabled === false || !hasConnectionCredentials(current))
            throw connectionError('UNAVAILABLE', `Flow connection unavailable: ${id}`);
        if (saved.baseURL !== (current.baseURL ?? provider.baseURL)) throw connectionError('CHANGED', `Flow connection changed after admission: ${id}`);
        return { ...current, model: saved.model, tiers: structuredClone(saved.tiers) };
    }, operationModelId: (id, operation) => entries.get(id)?.operationModels[operation],
    assertOperationIdentity(connection, provider, operation) {
        const saved = entries.get(connection.id);
        if (!saved || saved.mediaEndpoints[operation] !== mediaEndpointIdentity(provider, connection.baseURL, operation))
            throw connectionError('CHANGED', `Flow connection endpoint changed after admission: ${connection.id}`);
    } };
}

function catalogPorts(live: FlowConnectionCatalog): FlowConnectionCatalog {
    return { getConnection: id => live.getConnection(id), getProvider: id => live.getProvider(id),
        ...(live.getModelDefaults ? { getModelDefaults: () => live.getModelDefaults!() } : {}) };
}

function selection(connection: ConnectionMeta, provider: LLMProvider | undefined): FlowConnectionSelection {
    return { id: connection.id, providerId: connection.providerId, model: connection.model,
        ...(connection.tiers ? { tiers: structuredClone(connection.tiers) } : {}),
        ...(connection.protocol ? { protocol: connection.protocol } : {}), baseURL: connection.baseURL ?? provider?.baseURL ?? '',
        operationModels: Object.fromEntries(MODEL_OPERATIONS.flatMap(operation => {
            const model = modelForOperation(connection, provider, operation);
            return model ? [[operation, model.id]] : [];
        })), mediaEndpoints: Object.fromEntries(MODEL_OPERATIONS.flatMap(operation => {
            const endpoint = provider && mediaEndpointIdentity(provider, connection.baseURL, operation);
            return endpoint ? [[operation, endpoint]] : [];
        })) };
}

export function isFlowConnectionSnapshot(value: unknown): value is FlowConnectionSnapshot {
    if (!record(value) || !keys(value, ['connections']) || !Array.isArray(value.connections)) return false;
    const ids = new Set<string>();
    return value.connections.every(entry => {
        if (!record(entry) || !keys(entry, ['id', 'providerId', 'model', 'tiers', 'protocol', 'baseURL', 'operationModels', 'mediaEndpoints'])
            || !text(entry.id) || ids.has(entry.id) || !text(entry.providerId) || typeof entry.model !== 'string'
            || typeof entry.baseURL !== 'string' || entry.protocol !== undefined && !API_PROTOCOLS.includes(entry.protocol as never)
            || !stringMap(entry.operationModels, MODEL_OPERATIONS) || !stringMap(entry.mediaEndpoints, MODEL_OPERATIONS)
            || entry.tiers !== undefined && !stringMap(entry.tiers, ['optimal', 'standard', 'fast'])) return false;
        ids.add(entry.id); return true;
    });
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function stringMap(value: unknown, allowed: readonly string[]): boolean { return record(value) && keys(value, allowed) && Object.values(value).every(text); }
function connectionError(code: string, message: string): Error { return Object.assign(new Error(message), { code: `FLOW_CONNECTION_${code}` }); }

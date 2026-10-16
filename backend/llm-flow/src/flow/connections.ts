// @file: llm-flow/src/flow/connections.ts
// Resolve a workflow's named connection slots against a node's config.connectionId.
// A node may reference a slot by name (resolved to its global connectionId),
// pass a raw global connectionId through unchanged, or omit it (inherits the
// workflow default slot).

import type { FlowConnection, JsonValue } from '../contracts';

/**
 * Resolve a raw `connectionId` value to a global connection id:
 * - a slot name resolves through the workflow's `connections`;
 * - any other value (a raw global id) passes through;
 * - undefined falls back to `defaultConnection` (or the first slot).
 */
export function resolveConnectionId(
    raw: JsonValue | undefined,
    connections: FlowConnection[] | undefined,
    defaultConnection: string | undefined,
): string | undefined {
    const list = connections ?? [];
    if (typeof raw === 'string' && raw.length > 0) {
        const slot = list.find(item => item.name === raw);
        return slot ? slot.connectionId : raw;
    }
    const fallback = defaultConnection ?? list[0]?.name;
    if (!fallback) return undefined;
    const slot = list.find(item => item.name === fallback);
    return slot?.connectionId;
}

/**
 * In-place resolve `config.connectionId`: a node slot name maps through the
 * workflow's slots; an empty value inherits `defaultConnection`; when nothing
 * matches, `fallbackConnectionId` (e.g. the session's connection) is applied.
 */
export function resolveNodeConnection(
    config: JsonValue,
    connections: FlowConnection[] | undefined,
    defaultConnection: string | undefined,
    fallbackConnectionId?: string,
    runConnectionId?: string,
): void {
    if (!isRecord(config)) return;
    const slotName = nodeConnectionSlot(config, connections, defaultConnection, runConnectionId);
    if (slotName) {
        const slot = connections?.find(item => item.name === slotName);
        if (!slot) throw new Error(`Unknown connection slot: ${slotName}`);
        if (!slot.connectionId && slot.required !== false) throw new Error(`Missing connection binding: ${slotName}`);
        config.connectionId = slot.connectionId ?? '';
        if (slot.resolved) {
            if (config.modelName && config.modelName !== slot.resolved.modelId) throw new Error(`Model override conflicts with connection slot: ${slotName}`);
            config.modelName = slot.resolved.modelId;
            const requirements = config.connectionRequirements ?? slot.requirements;
            config.frozenConnection = { ...slot.resolved, ...(requirements ? { requirements } : {}) };
        }
        delete config.connectionSlot;
        return;
    }
    const explicit = typeof config.connectionId === 'string' && config.connectionId.length > 0;
    const resolved = (explicit ? resolveConnectionId(config.connectionId, connections, defaultConnection) : runConnectionId
        ?? resolveConnectionId(undefined, connections, defaultConnection)) ?? fallbackConnectionId;
    if (resolved !== undefined) config.connectionId = resolved;
}

/** Preserve implicit slot identity for host admission before replacing it with a global id. */
export function nodeConnectionSlot(config: JsonValue, connections: FlowConnection[] | undefined,
    defaultConnection: string | undefined, runConnectionId?: string): string | undefined {
    if (!isRecord(config)) return;
    if (typeof config.connectionSlot === 'string') return config.connectionSlot;
    if (typeof config.connectionId === 'string' && connections?.some(slot => slot.name === config.connectionId)) return config.connectionId;
    if (!config.connectionId && !runConnectionId) return connections?.find(slot => slot.name === (defaultConnection ?? connections?.[0]?.name))?.name;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

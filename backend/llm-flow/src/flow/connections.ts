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
    const explicit = typeof config.connectionId === 'string' && config.connectionId.length > 0;
    const resolved = (explicit ? resolveConnectionId(config.connectionId, connections, defaultConnection) : runConnectionId
        ?? resolveConnectionId(undefined, connections, defaultConnection)) ?? fallbackConnectionId;
    if (resolved !== undefined) config.connectionId = resolved;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

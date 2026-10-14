import type { JsonValue } from '../contracts';

/** Keep declared grants and scheduling policy while accepting resolved identity content. */
export function patchIdentityConfig(originalValue: unknown, boundValue: unknown, allowed: string[]): JsonValue {
    const original = record(originalValue), bound = record(boundValue);
    return {
        ...bound,
        toolIds: [...allowed],
        delegation: bindDelegation(record(original.delegation), record(bound.delegation)),
        // Legacy delegation declarations must not be installed by identity resolution either.
        subtasks: original.subtasks ?? null,
    };
}

function bindDelegation(original: Record<string, JsonValue>, bound: Record<string, JsonValue>): JsonValue {
    if (original.enabled !== true || !bound.resolvedTemplate) return original;
    const template = record(original.resolvedTemplate ?? original.template);
    const resolved = record(bound.resolvedTemplate);
    const allowed = Array.isArray(template.capabilities) ? template.capabilities.map(String) : [];
    return {
        ...original,
        resolvedTemplate: {
            ...resolved,
            ...template,
            config: patchIdentityConfig(template.config ?? template, resolved.config ?? {}, allowed),
            capabilities: allowed,
        },
    };
}

function record(value: unknown): Record<string, JsonValue> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, JsonValue> : {};
}

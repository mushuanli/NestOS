/** Shared value semantics for authoring, runtime validation and port compatibility. */
export function matchesSchemaType(type: string, value: unknown): boolean {
    if (type === 'null') return value === null;
    if (type === 'object') return record(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

export function equalJson(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => equalJson(item, right[index]));
    if (!record(left) || !record(right)) return false;
    return Object.keys(left).length === Object.keys(right).length
        && Object.keys(left).every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

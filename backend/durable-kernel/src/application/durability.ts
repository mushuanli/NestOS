// @file: durable-kernel/src/application/durability.ts
// 持久化校验：确保 Task state / output / action payload 可 JSON 序列化。

export function assertDurableValue(value: unknown, label: string): void {
    inspectDurableValue(value, label, new Set(), false);
}

export function inspectDurableValue(value: unknown, path: string, seen: Set<object>, nested: boolean): void {
    if (value === undefined && nested) return;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') throw new Error(`${path} is not JSON serializable`);
    if (seen.has(value)) throw new Error(`${path} contains a circular reference`);
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => inspectDurableValue(item, `${path}[${index}]`, seen, false));
    } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`${path} contains a non-JSON object`);
        }
        for (const [key, item] of Object.entries(value)) {
            inspectDurableValue(item, `${path}.${key}`, seen, true);
        }
    }
    seen.delete(value);
}

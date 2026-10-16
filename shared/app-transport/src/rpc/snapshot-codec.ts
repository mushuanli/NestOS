import type { WireValue } from './protocol';

/** Immutable DTO subtrees reuse wire objects; capabilities keep the normal encoder. */
export class SnapshotCodec {
    private readonly encoded = new WeakMap<object, WireValue>();
    encode(value: unknown): WireValue | undefined {
        if (value === undefined) return { $undefined: true };
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
        if (typeof value !== 'object') return undefined;
        const cached = this.encoded.get(value); if (cached !== undefined) return cached;
        const output = this.container(value); if (output === undefined) return undefined;
        if (Object.isFrozen(value)) { Object.freeze(output); this.encoded.set(value, output); }
        return output;
    }
    private container(value: object): WireValue | undefined {
        if (Array.isArray(value)) {
            const result: WireValue[] = [];
            for (const child of value) { const item = this.encode(child); if (item === undefined) return undefined; result.push(item); }
            return result;
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
        const fields: Record<string, WireValue> = Object.create(null);
        for (const [key, child] of Object.entries(value)) {
            const item = this.encode(child); if (item === undefined) return undefined; fields[key] = item;
        }
        if (Object.isFrozen(value)) Object.freeze(fields);
        return { $object: fields };
    }
}
const sizes = new WeakMap<object, number>();
/** Encoded objects are immutable across emitted descriptor versions. */
export function wireSize(value: WireValue): number {
    if (value === null || typeof value !== 'object') return JSON.stringify(value).length;
    const cached = sizes.get(value); if (cached !== undefined) return cached;
    const size = Array.isArray(value) ? 2 + value.reduce<number>((total, item) => total + wireSize(item) + 1, 0) - (value.length ? 1 : 0)
        : 2 + Object.entries(value).reduce((total, [key, item]) => total + JSON.stringify(key).length + 1 + wireSize(item) + 1, 0) - (Object.keys(value).length ? 1 : 0);
    sizes.set(value, size); return size;
}

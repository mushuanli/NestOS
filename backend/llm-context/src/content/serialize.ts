import { ContextError } from '../window/engine';

/** Reject live attachment objects instead of silently persisting an empty JSON body. */
export function serializeContext(value: unknown): string {
    return JSON.stringify(value, function (key, encoded) {
        const original = this[key];
        const kind = typeof original;
        const prototype = original && kind === 'object' ? Object.getPrototypeOf(original) : null;
        if (kind === 'function' || kind === 'symbol' || kind === 'bigint'
            || (kind === 'number' && !Number.isFinite(original))
            || (original && kind === 'object' && !Array.isArray(original) && prototype !== Object.prototype && prototype !== null)) {
            throw new ContextError('CONTEXT_INVALID_INPUT', 'Durable context requires JSON data; resolve live attachments before preparing');
        }
        return encoded;
    });
}

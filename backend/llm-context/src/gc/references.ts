import type { ContentRef } from '../domain/durable';

/** Recognize typed references and references embedded in admitted tool previews. */
export function contextReferences(value: unknown): ContentRef[] {
    const result: ContentRef[] = [];
    const pending: unknown[] = [value];
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === 'string') {
            for (const match of item.matchAll(/\{[^{}\n]*"sha256"[^{}\n]*\}/g)) {
                try { pending.push(JSON.parse(match[0])); } catch { /* Ordinary source text. */ }
            }
        } else if (item && typeof item === 'object') {
            const ref = item as ContentRef;
            if (isContextReference(item)) {
                if (typeof ref.id !== 'string' || typeof ref.sha256 !== 'string' || typeof ref.bytes !== 'number'
                    || typeof ref.mediaType !== 'string') throw new Error('Malformed context reference');
                result.push(ref);
            }
            for (const child of Object.values(item)) pending.push(child);
        }
    }
    return result;
}

function isContextReference(item: object): boolean {
    const value = item as Record<string, unknown>;
    // Context IDs are content hashes; binary asset IDs and business IDs use other namespaces.
    if ('mediaType' in value && ('id' in value || 'sha256' in value)) return true;
    return typeof value.id === 'string' && /^[a-f0-9]{64}$/.test(value.id) && 'sha256' in value;
}

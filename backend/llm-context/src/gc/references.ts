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
            if ('id' in item && 'sha256' in item) {
                if (typeof ref.id !== 'string' || typeof ref.sha256 !== 'string' || typeof ref.bytes !== 'number'
                    || typeof ref.mediaType !== 'string') throw new Error('Malformed context reference');
                result.push(ref);
            }
            for (const child of Object.values(item)) pending.push(child);
        }
    }
    return result;
}

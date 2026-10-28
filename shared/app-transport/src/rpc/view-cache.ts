import type { Descriptor, WireValue } from './protocol';

export interface WirePatch { path: Array<string | number>; value?: WireValue; append?: string; remove?: true;
    splice?: {start: number; deleteCount: number; text: string} }
export interface DescriptorPatch { id: string; baseVersion: number; version: number; changes: WirePatch[] }
const maxArrayPatchBytes = 64 * 1024;
/** Compare encoded data, preserving append-only token and history changes. */
export function descriptorChanges(previous: Descriptor, next: Descriptor): WirePatch[] {
    const changes: WirePatch[] = [];
    for (const key of ['fields', 'snapshots', 'lookups'] as const) diff(previous[key], next[key], [key], changes);
    return changes;
}
function diff(previous: WireValue | undefined, next: WireValue | undefined, path: WirePatch['path'], changes: WirePatch[]): void {
    if (previous === next) return;
    if (next === undefined) { changes.push({ path, remove: true }); return; }
    if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
        changes.push({ path, append: next.slice(previous.length) }); return;
    }
    if (typeof previous === 'string' && typeof next === 'string') {
        const splice = textSplice(previous, next);
        changes.push(splice.text.length + 64 < next.length ? {path, splice} : {path, value: next}); return;
    }
    if (Array.isArray(previous) && Array.isArray(next) && next.length >= previous.length) {
        const edits: WirePatch[] = [];
        next.forEach((item, index) => diff(previous[index], item, [...path, index], edits));
        const bytes = new TextEncoder().encode(JSON.stringify(edits)).byteLength;
        if (bytes > maxArrayPatchBytes) changes.push({path, value: next});
        else changes.push(...edits);
        return;
    }
    if (record(previous) && record(next)) {
        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]))
            diff(Object.hasOwn(previous, key) ? previous[key] : undefined, Object.hasOwn(next, key) ? next[key] : undefined, [...path, key], changes);
        return;
    }
    changes.push({ path, value: next });
}
function textSplice(previous: string, next: string): NonNullable<WirePatch['splice']> {
    let start = 0, end = 0;
    while (start < Math.min(previous.length, next.length) && previous[start] === next[start]) start++;
    while (end < Math.min(previous.length, next.length) - start && previous[previous.length - end - 1] === next[next.length - end - 1]) end++;
    return {start, deleteCount: previous.length - start - end, text: next.slice(start, next.length - end)};
}
function record(value: unknown): value is Record<string, WireValue> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function applyDescriptorPatch(descriptor: Descriptor, patch: DescriptorPatch): Descriptor {
    const result = { ...descriptor }, copies = new WeakMap<object, any>();
    copies.set(descriptor, result); copies.set(result, result);
    for (const change of patch.changes) applyChange(result, change, copies);
    result.version = patch.version;
    return result;
}
function applyChange(descriptor: Descriptor, change: WirePatch, copies: WeakMap<object, any>): void {
    if (!change.path.length || !['fields', 'snapshots', 'lookups'].includes(String(change.path[0])) || change.path.length > 64)
        throw new Error('Invalid view patch path');
    let target: any = descriptor;
    for (const key of change.path.slice(0, -1)) {
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('Unknown view patch path');
        const child = target[key];
        if (!child || typeof child !== 'object') throw new Error('Unknown view patch container');
        let copy = copies.get(child);
        if (!copy) {
            copy = Array.isArray(child) ? child.slice() : { ...child }; copies.set(child, copy); copies.set(copy, copy);
        }
        Object.defineProperty(target, key, { value: copy, enumerable: true, configurable: true, writable: true }); target = copy;
    }
    const key = change.path.at(-1)!;
    if (change.remove) { delete target[key]; return; }
    Object.defineProperty(target, key, { value: patchValue(target[key], change),
        enumerable: true, configurable: true, writable: true });
}
function patchValue(previous: WireValue | undefined, change: WirePatch): WireValue | undefined {
    if (change.splice) {
        const {start, deleteCount, text} = change.splice;
        if (typeof previous !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(deleteCount)
            || start < 0 || deleteCount < 0 || start + deleteCount > previous.length || typeof text !== 'string')
            throw new Error('Invalid view string splice');
        return previous.slice(0, start) + text + previous.slice(start + deleteCount);
    }
    if (change.append === undefined) return change.value;
    if (typeof previous !== 'string') throw new Error('Invalid view string append');
    return previous + change.append;
}

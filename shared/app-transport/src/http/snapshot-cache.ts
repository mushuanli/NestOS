import {FSError} from '@itookit/vfs-core';
import type {WireValue} from '../rpc/protocol';

const MAX_BYTES = 8 * 1024 * 1024, MAX_ENTRIES = 128;
const revisionPattern = /^[a-f0-9]{64}$/;
type Entry = {value: WireValue; bytes: number};
export interface SnapshotStorage { read(): string | null; write(value: string): void; }
export interface CachedReply {payload: WireValue; cache: Record<string, WireValue>;}
const bytes = (text: string) => new TextEncoder().encode(text);
async function digest(text: string): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function references(value: WireValue): boolean {
    if (!value || typeof value !== 'object') return false;
    if (!Array.isArray(value) && ['$ref', '$capability', '$cache'].some(key => key in value)) return true;
    return Object.values(value).some(references);
}
function freeze(value: WireValue): WireValue {
    if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
    return value;
}

/** Content-addressed DTOs are reusable; capabilities and connection identity never enter this cache. */
export class SnapshotCache {
    private readonly values = new Map<string, Entry>();
    private size = 0;
    constructor(private readonly storage?: SnapshotStorage) {}
    known(): string[] { return [...this.values.keys()]; }
    async load(): Promise<void> {
        try {
            const source = this.storage?.read();
            if (!source || bytes(source).length > MAX_BYTES) return;
            await this.accept(JSON.parse(source));
        } catch { /* Invalid or unavailable persistence falls back to a complete server snapshot. */ }
    }
    private put(revision: string, text: string): void {
        const length = bytes(text).length;
        if (length > MAX_BYTES) return;
        const previous = this.values.get(revision); if (previous) this.size -= previous.bytes;
        this.values.delete(revision); this.values.set(revision, previous ?? {value: freeze(JSON.parse(text)), bytes: length}); this.size += length;
        while (this.values.size > MAX_ENTRIES || this.size > MAX_BYTES) {
            const key = this.values.keys().next().value!; this.size -= this.values.get(key)!.bytes; this.values.delete(key);
        }
    }
    private async accept(data: Record<string, WireValue>): Promise<void> {
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > MAX_ENTRIES)
            throw new FSError('EINVAL', 'Invalid snapshot cache');
        for (const [revision, value] of Object.entries(data)) {
            const text = JSON.stringify(value);
            if (!revisionPattern.test(revision) || references(value) || await digest(text) !== revision)
                throw new FSError('EINVAL', 'Invalid cached snapshot revision');
            this.put(revision, text);
        }
    }
    async pack(payload: WireValue, known: readonly string[]): Promise<CachedReply> {
        if (!Array.isArray(known) || known.length > MAX_ENTRIES || known.some(value => !revisionPattern.test(value)))
            throw new FSError('EINVAL', 'Invalid known snapshot revisions');
        const cache: Record<string, WireValue> = {}, received = new Set(known);
        return {payload: await this.packValue(payload, received, cache), cache};
    }
    private async packValue(value: WireValue, known: Set<string>, cache: Record<string, WireValue>): Promise<WireValue> {
        if (!value || typeof value !== 'object') return value;
        if ((Array.isArray(value) || '$object' in value) && !references(value)) {
            const text = JSON.stringify(value), length = bytes(text).length;
            if (length >= 1024 && length <= 128 * 1024) {
                const revision = await digest(text);
                if (known.has(revision) || revision in cache || Object.keys(cache).length < MAX_ENTRIES) {
                    this.put(revision, text);
                    if (!known.has(revision)) cache[revision] = this.values.get(revision)!.value;
                    return {$cache: revision};
                }
            }
        }
        const pairs = await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await this.packValue(child, known, cache)] as const));
        return Array.isArray(value) ? pairs.map(([, item]) => item) : Object.fromEntries(pairs);
    }
    async unpack(packet: CachedReply): Promise<WireValue> {
        const available = new Map([...this.values].map(([key, entry]) => [key, entry.value]));
        await this.accept(packet.cache);
        for (const [key, value] of Object.entries(packet.cache)) available.set(key, value);
        const result = this.expand(packet.payload, available);
        try {this.storage?.write(JSON.stringify(Object.fromEntries([...this.values].map(([key, entry]) => [key, entry.value]))));}
        catch { /* Storage quotas do not prevent displaying the authoritative response. */ }
        return result;
    }
    private expand(value: WireValue, available: Map<string, WireValue>): WireValue {
        if (!value || typeof value !== 'object') return value;
        if (!Array.isArray(value) && '$cache' in value) {
            const found = available.get(String(value.$cache));
            if (found === undefined) throw new FSError('ENOENT', 'Snapshot cache entry missing');
            return found;
        }
        if (Array.isArray(value)) return value.map(child => this.expand(child, available));
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.expand(child, available)]));
    }
}

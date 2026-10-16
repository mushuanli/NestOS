import type { WireValue } from './protocol';

/** Capabilities returned together share a lease, released by their cleanup capability. */
export class CapabilityLifetime {
    private readonly leases = new Map<string, { roots: Set<string>; owners: Set<string> }>();
    private readonly attached = new Map<string, Set<string>>();
    private readonly children = new Map<string, Set<string>>();
    retain(value: WireValue, owns: (id: string) => boolean): void {
        const roots = capabilityReferences(value), owners = new Set([...roots].filter(owns));
        if (roots.size) this.leases.set([...roots].sort().join(','), { roots, owners });
    }
    attach(id: string, value: WireValue): void {
        const children = this.attached.get(id) ?? new Set<string>();
        capabilityReferences(value).forEach(child => children.add(child)); this.attached.set(id, children);
    }
    describe(id: string, value: WireValue): void { this.children.set(id, capabilityReferences(value)); }
    release(id: string): void {
        for (const [key, lease] of this.leases) {
            if (lease.owners.delete(id) && !lease.owners.size) this.leases.delete(key);
            else lease.roots.delete(id);
            if (!lease.roots.size) this.leases.delete(key);
        }
        this.children.delete(id);
    }
    acquire(value: WireValue): () => void {
        const key = crypto.randomUUID(); this.leases.set(key, { roots: capabilityReferences(value), owners: new Set() });
        return () => { this.leases.delete(key); };
    }
    reachable(): Set<string> {
        const live = new Set<string>();
        const visit = (id: string) => {
            if (live.has(id)) return;
            live.add(id); this.children.get(id)?.forEach(visit); this.attached.get(id)?.forEach(visit);
        };
        for (const lease of this.leases.values()) lease.roots.forEach(visit);
        return live;
    }
    forget(id: string): void {
        this.children.delete(id); this.attached.delete(id);
        for (const children of this.attached.values()) children.delete(id);
    }
    clear(): void { this.leases.clear(); this.children.clear(); this.attached.clear(); }
}
const referenceCache = new WeakMap<object, ReadonlySet<string>>();
export function capabilityReferences(value: WireValue): Set<string> {
    if (!value || typeof value !== 'object') return new Set();
    const cached = referenceCache.get(value); if (cached) return new Set(cached);
    if (!Array.isArray(value) && typeof value.$ref === 'string') return new Set([value.$ref]);
    if (!Array.isArray(value) && value.$capability && typeof value.$capability === 'object' && !Array.isArray(value.$capability))
        return new Set([String(value.$capability.id)]);
    const ids = new Set<string>();
    for (const item of Object.values(value)) for (const id of capabilityReferences(item)) ids.add(id);
    if (Object.isFrozen(value)) referenceCache.set(value, ids);
    return ids;
}

/** Monotonic capability IDs allow compact tombstones without retaining dead proxies. */
export class CapabilityRetirements {
    private readonly ranges = new Map<string, Array<[number, number]>>();
    private identity(id: string): [string, number] { const index = id.lastIndexOf(':'); return [id.slice(0, index), Number(id.slice(index + 1))]; }
    add(id: string): void {
        const [identity, sequence] = this.identity(id), ranges = [...(this.ranges.get(identity) ?? []), [sequence, sequence] as [number, number]];
        ranges.sort((a, b) => a[0] - b[0]);
        const merged: Array<[number, number]> = [];
        for (const range of ranges) {
            const previous = merged.at(-1);
            if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
            else merged.push(range);
        }
        this.ranges.set(identity, merged);
    }
    has(id: string): boolean {
        const [identity, sequence] = this.identity(id);
        return this.ranges.get(identity)?.some(([from, to]) => from <= sequence && sequence <= to) ?? false;
    }
    clear(): void { this.ranges.clear(); }
}

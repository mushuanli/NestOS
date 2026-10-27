import { randomUUID } from './random';
import { SnapshotCodec, wireSize } from './snapshot-codec';
import { FSError } from '@itookit/vfs-core';
import { affectedDomains, isViewQuery, viewDomain, subscriptionMode, type ViewDomain, type CapabilitySchema, type CapabilityRegistry } from './capabilities';
import type { Call, Reply, WireValue, Descriptor } from './protocol';
import { MAX_RPC_HANDLES } from './protocol';
import { CapabilityLifetime, CapabilityRetirements, capabilityReferences } from './lifetime';
import { applyDescriptorPatch, descriptorChanges, type DescriptorPatch } from './view-cache';

const FUNCTION: CapabilitySchema = { markers: [], fields: [], methods: { call: 'async' } };
const OWNED: CapabilitySchema = { markers: [], fields: ['fs', 'context', 'attachments', 'initialData'], methods: {
    dispose: 'async', release: 'async', put: 'async', read: 'async', save: 'async', clear: 'async', prepare: 'async',
    next: 'async', return: 'async' } };
type Handle = { value: any; kind: string; schema: CapabilitySchema; retired?: boolean };
/** Both sides transport only explicit capabilities and data, never executable source. */
export class RpcPeer {
    private readonly lifetime = new CapabilityLifetime();
    private readonly snapshotCodec = new SnapshotCodec();
    private readonly subscriptionReleases = new Map<string, Set<() => Promise<void>>>();
    private readonly observerReleases = new Map<string, () => void>();
    private readonly observing = new Map<string, Promise<void>>();
    private readonly retired = new Set<string>();
    private readonly localRetirements = new CapabilityRetirements();
    private readonly remoteRetirements = new CapabilityRetirements();
    private operations = 0;
    private collectionNeeded = false;
    private readonly handles = new Map<string, Handle>();
    private readonly ids = new WeakMap<object, string>();
    private readonly remote = new Map<string, any>();
    private readonly remoteIds = new WeakMap<object, string>();
    private readonly descriptors = new Map<string, Descriptor>();
    private readonly pendingPatches = new Map<string, DescriptorPatch[]>();
    private readonly decodedSnapshots = new WeakMap<object, unknown>();
    private readonly updateWaiters = new Set<() => void>();
    private readonly lookupArgs = new Map<string, Map<string, unknown[]>>();
    private readonly releases = new Set<() => void | Promise<void>>();
    private readonly remoteCleanups = new Set<string>();
    private readonly pendingUnsubscriptions = new Set<Promise<unknown>>();
    private unsubscribing = 0;
    private readonly pendingBindings = new Set<Promise<unknown>>();
    private readonly pendingInvocations = new Set<Promise<unknown>>();
    private readonly eventCallbacks = new Set<string>();
    private readonly notificationTails = new Map<string, Promise<unknown>>();
    private readonly cleanupFunctions = new WeakSet<object>();
    private readonly callbackUses = new Map<string, { active: number; persistent: number }>();
    private readonly emitted = new Map<string, Descriptor>();
    private readonly dirty = new Set<string>();
    private readonly domains = new Set<ViewDomain>();
    private refreshTail: Promise<unknown> = Promise.resolve();
    private readonly projectionsLoaded = new Map<string, unknown>();
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    private sequence = 0;
    private readonly identity = randomUUID();
    private closed = false;
    private onInvalidation?: () => void;
    private fileTransport?: (target: string, method: string, args: unknown[]) => Promise<unknown>;
    constructor(private readonly side: 'client' | 'server', private readonly send: (call: Call) => Promise<Reply>,
        private readonly report: (error: unknown) => void = console.error,
        private readonly projections?: (kind: string, proxy: any) => void,
        private readonly prepare?: (domains: ReadonlySet<ViewDomain>) => void | Promise<void>,
        private readonly schemas: CapabilityRegistry = {}) {}
    expose(value: unknown, kind?: string): Promise<WireValue> {
        return this.operation(async () => {
            const encoded = await this.encode(value, new Set(), kind); this.retain(encoded); return encoded;
        });
    }
    private async operation<T>(run: () => Promise<T>): Promise<T> {
        this.operations++;
        try { return await run(); } finally { this.endOperation(); }
    }
    private endOperation(): void { if (!--this.operations && this.collectionNeeded) this.collectReleased(); }
    private retain(value: WireValue): void {
        const refs = capabilityReferences(value);
        const cleanup = [...refs].filter(id => this.cleanupFunctions.has(this.handles.get(id)?.value));
        this.lifetime.retain(value, id => {
            if (cleanup.length) return cleanup.includes(id);
            const handle = this.handles.get(id);
            return !!handle && ['dispose', 'release', 'return', 'close'].some(name => name in handle.schema.methods && typeof handle.value[name] === 'function');
        });
    }
    bootstrap(value: unknown): Promise<Reply> {
        return this.operation(async () => {
            const root = await this.encode(value, new Set(), undefined, true);
            // Bootstrap services live with the connection, independently of disposable initial views.
            this.lifetime.retain(root, () => false);
            return { value: root, updates: await this.refresh() };
        });
    }
    invalidate(...domains: ViewDomain[]): void {
        domains.forEach(domain => this.domains.add(domain));

    }
    *localValues<T>(kind: string): Iterable<T> {
        for (const handle of this.handles.values()) if (handle.kind === kind && !handle.retired) yield handle.value as T;
    }
    onInvalidated(listener: () => void): void { this.onInvalidation = listener; }
    setFileTransport(send: (target: string, method: string, args: unknown[]) => Promise<unknown>): void { this.fileTransport = send; }
    private binaryCall(id: string, method: string, args: any[]): boolean {
        if (!this.fileTransport || !this.schemas[this.descriptors.get(id)?.kind ?? '']?.binary) return false;
        if (method === 'readContent') return args[1]?.encoding === 'binary';
        return method === 'writeContent' && (args[1] instanceof ArrayBuffer || ArrayBuffer.isView(args[1]));
    }
    private fileHandle(call: Call): Handle {
        const handle = this.handles.get(call.target);
        if (this.closed || !handle || handle.retired || !handle.schema.binary || !['readContent', 'writeContent'].includes(call.method))
            throw new FSError('ECAPABILITY', 'Unknown file capability');
        return handle;
    }
    async readBinary(call: Call): Promise<{ bytes: ArrayBuffer; revision?: string }> {
        if (call.method !== 'readContent') throw new FSError('ECAPABILITY', 'Expected file read');
        const handle = this.fileHandle(call), args = call.args.map(arg => this.decode(arg));
        let revision: string | undefined;
        const bytes = await handle.value.readContent(args[0], { ...args[1], encoding: 'binary', onRevision: (value: string | undefined) => { revision = value; } });
        return { bytes, revision };
    }
    async writeBinary(call: Call, bytes: ArrayBuffer): Promise<Reply & { fileRevision?: string }> {
        if (call.method !== 'writeContent') throw new FSError('ECAPABILITY', 'Expected file write');
        this.fileHandle(call); let fileRevision: string | undefined;
        const reply = await this.handle(call, true, bytes, value => { fileRevision = value; });
        return { ...reply, fileRevision };
    }
    query(call: Call): boolean {
        const handle = this.handles.get(call.target);
        return !!handle && !handle.retired && Object.hasOwn(handle.schema.methods, call.method)
            && isViewQuery(this.schemas, call, handle.kind, handle.schema.methods[call.method]);
    }
    remoteQuery(call: Call): boolean {
        const kind = this.descriptors.get(call.target)?.kind;
        return !!kind && isViewQuery(this.schemas, call, kind, this.schemas[kind]?.methods[call.method]);
    }
    binding(call: Call): boolean { return subscriptionMode(this.handles.get(call.target)?.schema.methods[call.method]); }
    /** Diagnostics contain only registered public names, never caller-supplied arguments. */
    operationName(call: Call): string {
        const handle = this.handles.get(call.target);
        if (handle && Object.hasOwn(handle.schema.methods, call.method)) return `${handle.kind}.${call.method}`;
        return Object.values(this.schemas).some(schema => Object.hasOwn(schema.methods, call.method)) ? `unknown.${call.method}` : 'unknown';
    }
    remoteBinding(call: Call): boolean {
        const kind = this.descriptors.get(call.target)?.kind;
        return !!kind && subscriptionMode(this.schemas[kind]?.methods[call.method]);
    }
    private schema(value: any, kind?: string): [string, CapabilitySchema] | undefined {
        if (kind) return [kind, this.schemas[kind] ?? OWNED];
        if (typeof value === 'function') return ['Function', FUNCTION];
        const candidates = Object.entries(this.schemas).filter(([, schema]) => schema.markers.every(key => key in value && (!(key in schema.methods) || typeof value[key] === 'function')));
        candidates.sort((a, b) => b[1].markers.length - a[1].markers.length || Object.keys(b[1].methods).length - Object.keys(a[1].methods).length);
        if (candidates.length) return candidates[0];
        return undefined;
    }
    private async register(value: object, kind: string, schema: CapabilitySchema): Promise<string> {
        let id = this.ids.get(value);
        if (id) {
            await this.observing.get(id);
            if (this.closed) throw new FSError('EIO', 'View connection is closed');
            return id;
        }
        if (this.closed) throw new FSError('EIO', 'View connection is closed');
        if (this.handles.size >= MAX_RPC_HANDLES) throw new FSError('EBUSY', 'View capability limit reached');
        id = `${this.side}:${this.identity}:${++this.sequence}`; this.ids.set(value, id); this.handles.set(id, { value, kind, schema });
        this.dirty.add(id); this.domains.add(viewDomain(this.schemas, kind));
        const ready = this.observe(value, kind, id); this.observing.set(id, ready);
        try { await ready; }
        catch (error) {
            this.ids.delete(value); this.handles.delete(id); this.dirty.delete(id); throw error;
        } finally { this.observing.delete(id); }
        if (this.closed) throw new FSError('EIO', 'View connection is closed');
        return id;
    }
    private async encode(value: any, seen: Set<string>, kind?: string, flat = false): Promise<WireValue> {
        const builtin = await this.encodeBuiltin(value, seen, flat); if (builtin !== undefined) return builtin;
        const remote = this.remoteIds.get(value); if (remote) return { $ref: remote };
        const capability = this.schema(value, kind);
        if (capability) {
            const [name, schema] = capability, id = await this.register(value, name, schema);
            if ((flat && name !== 'Function') || seen.has(id)) return { $ref: id }; seen.add(id);
            return { $capability: await this.describe(id, seen) as unknown as WireValue };
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
            throw new FSError('ECAPABILITY', 'Value has no public transport capability: ' + value.constructor?.name);
        return this.encodeRecord(value, seen, flat);
    }
    private async encodeBuiltin(value: any, seen: Set<string>, flat: boolean): Promise<WireValue | undefined> {
        if (value === undefined) return { $undefined: true };
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
        if (value instanceof AbortSignal) return { $signal: value.aborted };
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return encodeBytes(value);
        if (value instanceof Blob) return { $blob: await this.encode(await value.arrayBuffer(), seen, undefined, flat), type: value.type };
        if (value instanceof Map) return { $map: await this.encode([...value.entries()], seen, undefined, flat) };
        if (value instanceof Set) return { $set: await this.encode([...value], seen, undefined, flat) };
        if (Array.isArray(value)) return Promise.all(value.map(item => this.encode(item, seen, undefined, flat)));
        return undefined;
    }
    private async encodeRecord(value: object, seen: Set<string>, flat: boolean): Promise<WireValue> {
        const output: Record<string, WireValue> = Object.create(null);
        for (const [key, item] of Object.entries(value)) {
            if (['dispose', 'release', 'return'].includes(key) && typeof item === 'function') this.cleanupFunctions.add(item);
            output[key] = await this.encode(item, seen, undefined, flat);
        }
        return { $object: output };
    }
    private async describe(id: string, seen: Set<string>, flat = false): Promise<Descriptor> {
        const { value, kind, schema } = this.handles.get(id)!;
        const fields: Record<string, WireValue> = {}, snapshots: Record<string, WireValue> = {}, lookups: Record<string, WireValue> = {};
        for (const key of schema.fields) if (key in value) { try { fields[key] = await this.encode(value[key], seen, schema.fieldKinds?.[key], flat); } catch (error) { throw new Error(kind + '.' + key + ': ' + String(error)); } }
        for (const [name, mode] of Object.entries(schema.methods)) {
            if (typeof value[name] !== 'function') continue;
            if (mode === 'snapshot') {
                try {
                    const source = schema.snapshotView ? schema.snapshotView(value, name) : value[name]();
                    snapshots[name] = schema.snapshotView ? this.snapshotCodec.encode(source) ?? await this.encode(source, seen, undefined, flat)
                        : await this.encode(source, seen, undefined, flat);
                } catch (error) {
                    throw new FSError(error instanceof FSError ? error.code : 'EIO',
                        'Snapshot encoding failed', `${kind}.${name}`, undefined, error instanceof Error ? error : undefined);
                }
            }
        }
        for (const [key, args] of this.lookupArgs.get(id) ?? []) {
            const name = key.slice(0, key.indexOf(':'));
            lookups[key] = await this.encode(value[name](...args), seen, undefined, flat);
        }
        // Only implemented optional methods are advertised.
        fields.$methods = Object.keys(schema.methods).filter(key => typeof value[key] === 'function');
        this.lifetime.describe(id, { fields, snapshots, lookups });
        return { id, kind, fields, snapshots, lookups };
    }
    async refresh(): Promise<WireValue[]> {
        const pending = this.operation(() => this.refreshTail.then(() => this.refreshDirty()));
        this.refreshTail = pending.catch(() => {}); return pending;
    }
    private async refreshDirty(): Promise<WireValue[]> {
        const updates: WireValue[] = [];
        for (let pass = 0; pass < 8; pass++) {
            updates.push(...await this.refreshPass());
            if (!this.domains.size) break;
        }
        return [...updates, ...this.retirementUpdates()];
    }
    private async refreshPass(): Promise<WireValue[]> {
        const domains = new Set(this.domains); this.domains.clear();
        if (domains.size) await this.prepare?.(domains);
        const updates: WireValue[] = [], seen = new Set<string>();
        for (const [id, { kind, retired }] of this.handles) {
            if (domains.has(viewDomain(this.schemas, kind))) this.dirty.add(id);
            if (kind === 'Function' || retired || !this.dirty.delete(id)) continue;
            seen.add(id);
            const descriptor = await this.describe(id, seen, true), previous = this.emitted.get(id);
            const changes = previous ? descriptorChanges(previous, descriptor) : undefined;
            if (changes?.length === 0) continue;
            descriptor.version = (previous?.version ?? 0) + 1;
            const full = { $capability: descriptor as unknown as WireValue };
            const patch = { $patch: { id, baseVersion: previous?.version ?? 0, version: descriptor.version, changes } as unknown as WireValue };
            updates.push(changes && wireSize(patch) < wireSize(full) ? patch : full);
            this.emitted.set(id, descriptor);
        }
        return updates;
    }
    private async observe(value: any, kind: string, id: string): Promise<void> {
        const method = this.schemas[kind]?.observer;
        if (!method || (typeof method === 'string' && typeof value[method] !== 'function')) return;
        const changed = () => { this.eventInvalidated(id); this.onInvalidation?.(); };
        const release = await (typeof method === 'function' ? method(value, changed) : value[method](changed));
        if (typeof release !== 'function') return;
        if (this.closed) { release(); return; }
        this.releases.add(release); this.observerReleases.set(id, release);
    }
    private eventInvalidated(id: string): void {
        const handle = this.handles.get(id); if (!handle || handle.retired) return;
        this.dirty.add(id);
        if (!handle.schema.scopedObserver) this.invalidate(...affectedDomains(this.schemas, handle.kind));
    }
    decode(value: WireValue): any {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(item => this.decode(item));
        if ('$snapshot' in value) {
            const reference = value.$snapshot as { id: string; method: string }, descriptor = this.descriptors.get(reference.id);
            if (!descriptor || !Object.hasOwn(descriptor.snapshots, reference.method)) throw new FSError('ECAPABILITY', 'Unknown snapshot result');
            return this.decodeSnapshot(descriptor.snapshots[reference.method]);
        }
        if ('$undefined' in value) return undefined;
        if ('$number' in value) return Number(value.$number);
        if ('$signal' in value) { const control = new AbortController(); if (value.$signal) control.abort(); return control.signal; }
        if ('$bytes' in value) { const bytes = Uint8Array.from(atob(value.$bytes as string), c => c.charCodeAt(0)); return value.typed ? bytes : bytes.buffer; }
        if ('$blob' in value) return new Blob([this.decode(value.$blob)], { type: value.type as string });
        if ('$map' in value) return new Map(this.decode(value.$map));
        if ('$set' in value) return new Set(this.decode(value.$set));
        if ('$ref' in value) {
            const id = value.$ref as string;
            const handle = this.handles.get(id);
            if (handle?.retired) throw new FSError('ECAPABILITY', 'Capability was released');
            if (handle) return handle.value;
            const remote = this.remote.get(id); if (!remote) throw new FSError('ECAPABILITY', 'Unknown capability reference'); return remote;
        }
        if ('$capability' in value) return this.hydrate(value.$capability as unknown as Descriptor);
        const result: Record<string, unknown> = {};
        const fields = ('$object' in value ? value.$object : value) as Record<string, WireValue>;
        for (const [key, item] of Object.entries(fields)) {
            const decoded = this.decode(item);
            if (['dispose', 'release', 'return', 'close'].includes(key) && typeof decoded === 'function') {
                const id = this.remoteIds.get(decoded); if (id) this.remoteCleanups.add(id);
            }
            Object.defineProperty(result, key, {value: decoded, enumerable: true, configurable: true, writable: true});
        }
        return result;
    }
    private hydrate(descriptor: Descriptor): any {
        let proxy = this.allocate(descriptor);
        const previous = this.descriptors.get(descriptor.id);
        if (previous?.version && (!descriptor.version || previous.version >= descriptor.version)) return proxy;
        this.descriptors.set(descriptor.id, descriptor);
        const schema = descriptor.kind === 'Owned' ? OWNED : this.schemas[descriptor.kind] ?? FUNCTION;
        for (const [key, item] of Object.entries(descriptor.fields)) if (schema.fields.includes(key)) proxy[key] = this.decode(item);
        for (const name of this.decode(descriptor.fields.$methods ?? []) as string[]) {
            if (!Object.hasOwn(schema.methods, name)) throw new FSError('ECAPABILITY', 'Unknown remote method');
            const mode = schema.methods[name];
            if (mode === 'snapshot') proxy[name] = () => {
                const value = this.descriptors.get(descriptor.id)!.snapshots[name];
                return schema.sharedSnapshots ? this.decodeSnapshot(value) : this.decode(value);
            };
            else if (mode === 'lookup') proxy[name] = (...args: unknown[]) => this.lookup(descriptor.id, name, args);
            else if (mode === 'notify') proxy[name] = (...args: unknown[]) => { void this.invoke(descriptor.id, name, args).catch(this.report); };
            else if (mode === 'subscribe') proxy[name] = (...args: unknown[]) => this.subscription(descriptor.id, name, args).stop;
            else if (mode === 'async-subscribe') proxy[name] = (...args: unknown[]) => {
                const binding = this.subscription(descriptor.id, name, args); return binding.ready.then(() => binding.stop);
            };
            else if (mode === 'iterator') proxy[name] = (...args: unknown[]) => this.iterate(descriptor.id, name, args);
            else proxy[name] = (...args: unknown[]) => this.invoke(descriptor.id, name, args);
        }
        this.projections?.(descriptor.kind, proxy);
        return proxy;
    }
    private decodeSnapshot(value: WireValue): unknown {
        if (!value || typeof value !== 'object') return this.decode(value);
        if (this.decodedSnapshots.has(value)) return this.decodedSnapshots.get(value);
        if (Array.isArray(value)) {
            const result = value.map(item => this.decodeSnapshot(item)); this.decodedSnapshots.set(value, result); return result;
        }
        if (!value.$object || typeof value.$object !== 'object' || Array.isArray(value.$object)) return this.decode(value);
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value.$object)) Object.defineProperty(result, key, {
            value: this.decodeSnapshot(item), enumerable: true, configurable: true, writable: true });
        this.decodedSnapshots.set(value, result); return result;
    }
    private allocate(descriptor: Descriptor): any {
        if (this.remoteRetirements.has(descriptor.id)) throw new FSError('ECAPABILITY', 'Capability was released');
        if (!descriptor.id.startsWith(this.side === 'client' ? 'server:' : 'client:') || !(descriptor.kind === 'Function' || this.schemas[descriptor.kind])) throw new FSError('ECAPABILITY', 'Invalid remote capability');
        let proxy = this.remote.get(descriptor.id);
        if (!proxy) {
            proxy = descriptor.kind === 'Function' ? (...args: unknown[]) => this.invoke(descriptor.id, 'call', args) : {};
            this.remote.set(descriptor.id, proxy); this.remoteIds.set(proxy, descriptor.id);
        }
        return proxy;
    }
    applyUpdates(updates: WireValue[] = []): void {
        for (const update of updates) if (update && !Array.isArray(update) && typeof update === 'object' && update.$capability
            && !this.retiredUpdate(update)) this.allocate(update.$capability as unknown as Descriptor);
        for (const update of updates) {
            if (this.retiredUpdate(update)) continue;
            if (update && !Array.isArray(update) && typeof update === 'object' && typeof update.$retired === 'string') {
                this.retireRemote(update.$retired); continue;
            }
            if (update && !Array.isArray(update) && typeof update === 'object' && update.$patch) {
                const patch = update.$patch as unknown as DescriptorPatch, previous = this.descriptors.get(patch.id);
                if (!previous) throw new FSError('ECAPABILITY', 'Unknown view patch target');
                if ((previous.version ?? 0) >= patch.version) continue;
                const pending = this.pendingPatches.get(patch.id) ?? [];
                if (pending.length >= 64) throw new FSError('ECAPABILITY', 'View update gap is too large');
                pending.push(patch); this.pendingPatches.set(patch.id, pending);
            } else this.decode(update);
        }
        this.drainPatches();
        for (const ready of this.updateWaiters) ready();
    }
    private retiredUpdate(update: WireValue): boolean {
        if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
        const descriptor = update.$patch ?? update.$capability;
        return !!descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) && this.remoteRetirements.has(String(descriptor.id));
    }
    private retireRemote(id: string): void {
        this.remoteRetirements.add(id);
        const proxy = this.remote.get(id); if (proxy) this.remoteIds.delete(proxy);
        this.remote.delete(id); this.descriptors.delete(id); this.remoteCleanups.delete(id); this.pendingPatches.delete(id); this.listeners.delete(id);
        for (const key of this.projectionsLoaded.keys()) if (key.startsWith(id + ':')) this.projectionsLoaded.delete(key);
    }
    private drainPatches(): void {
        for (const [id, patches] of this.pendingPatches) {
            patches.sort((a, b) => a.version - b.version);
            while (patches.length) {
                const descriptor = this.descriptors.get(id)!, patch = patches[0];
                if (patch.version <= (descriptor.version ?? 0)) { patches.shift(); continue; }
                if (patch.baseVersion !== (descriptor.version ?? 0)) break;
                patches.shift(); this.hydrate(applyDescriptorPatch(descriptor, patch));
            }
            if (!patches.length) this.pendingPatches.delete(id);
        }
    }
    waitUpdates(updates: WireValue[] = []): Promise<void> {
        const versions = updates.flatMap(update => {
            if (!update || typeof update !== 'object' || Array.isArray(update)) return [];
            const value = update.$patch ?? update.$capability;
            return value && typeof value === 'object' && !Array.isArray(value) ? [{ id: String(value.id), version: Number(value.version ?? 0) }] : [];
        });
        if (versions.every(item => this.remoteRetirements.has(item.id) || (this.descriptors.get(item.id)?.version ?? 0) >= item.version)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.updateWaiters.delete(ready); reject(new FSError('EIO', 'Missing view update')); }, 5000);
            const ready = () => {
                if (!this.closed && !versions.every(item => this.remoteRetirements.has(item.id) || (this.descriptors.get(item.id)?.version ?? 0) >= item.version)) return;
                clearTimeout(timer); this.updateWaiters.delete(ready); this.closed ? reject(new FSError('EIO', 'View closed')) : resolve();
            };
            this.updateWaiters.add(ready);
        });
    }
    private lookup(id: string, method: string, args: unknown[]): unknown {
        const key = `${method}:${JSON.stringify(args)}`, descriptor = this.descriptors.get(id)!;
        if (!(key in descriptor.lookups)) {
            const loaded = `${id}:${key}`;
            if (this.projectionsLoaded.has(loaded)) return this.projectionsLoaded.get(loaded);
            const schema = this.schemas[descriptor.kind];
            if (schema?.lazyLookups) {
                this.projectionsLoaded.set(loaded, undefined);
                void this.invoke(id, method, args).then(value => { this.projectionsLoaded.set(loaded, value); for (const listener of this.listeners.get(id) ?? []) listener(); }).catch(this.report);
                return undefined;
            }
            if (schema?.lookupDefaults && Object.hasOwn(schema.lookupDefaults, method)) return this.decode(schema.lookupDefaults[method]);
            throw new FSError('ECAPABILITY', `Snapshot lookup was not loaded: ${method}`);
        }
        return this.decode(descriptor.lookups[key]);
    }
    remember(value: object, method: string, args: unknown[]): void {
        const id = this.ids.get(value); if (!id) return;
        const argsByKey = this.lookupArgs.get(id) ?? new Map<string, unknown[]>();
        const key = `${method}:${JSON.stringify(args)}`;
        if (argsByKey.has(key)) return;
        argsByKey.set(key, args); this.lookupArgs.set(id, argsByKey);
        this.dirty.add(id);
    }
    private subscription(id: string, name: string, args: unknown[]): { ready: Promise<unknown>; stop(): void } {
        let stopped = false;
        const callback = [...args].reverse().find(arg => typeof arg === 'function') as (...args: any[]) => void;
        const listeners = this.listeners.get(id) ?? new Set(); listeners.add(callback); this.listeners.set(id, listeners);
        const pending = this.invoke(id, name, args);
        this.pendingBindings.add(pending);
        void pending.finally(() => this.pendingBindings.delete(pending)).catch(() => {});
        const finish = () => { for (const arg of args) if (typeof arg === 'function') {
            const key = this.ids.get(arg); if (key) this.releaseCallback(key, false, true);
        } };
        void pending.catch(() => { if (!stopped) { stopped = true; listeners.delete(callback); finish(); } });
        return { ready: pending, stop: () => { if (stopped) return; stopped = true; listeners.delete(callback);
            const work = pending.then(release => {
                this.unsubscribing++; try {return release?.();} finally {this.unsubscribing--;}
            }).finally(finish);
            this.pendingUnsubscriptions.add(work);
            void this.trackInvocation(work.finally(() => this.pendingUnsubscriptions.delete(work))).catch(this.report); } };
    }
    private async *iterate(id: string, name: string, args: unknown[]): AsyncIterable<unknown> {
        const iterator = await this.invoke(id, name, args);
        try { while (true) { const next = await iterator.next(); if (next.done) return; yield next.value; } }
        finally { await iterator.return?.(); }
    }
    invoke(id: string, method: string, args: unknown[]): Promise<any> {
        const mode = this.schemas[this.descriptors.get(id)?.kind ?? '']?.methods[method];
        // Capture earlier registrations synchronously; reads remain concurrent.
        const bindings = this.side === 'client' && !subscriptionMode(mode)
            && !this.remoteQuery({target: id, method, args: args as Call['args']})
            ? [...this.pendingBindings] : [];
        if (!this.unsubscribing && (['dispose', 'release', 'return', 'close'].includes(method) || this.remoteCleanups.has(id)) && this.pendingUnsubscriptions.size)
            bindings.push(Promise.allSettled([...this.pendingUnsubscriptions]));
        return this.trackInvocation(this.operation(() => bindings.length ? Promise.all(bindings).then(() => this.invokeOrdered(id, method, args))
            : this.invokeOrdered(id, method, args)));
    }

    /** Encode and deliver each observer's notifications in invocation order. */
    private invokeOrdered(id: string, method: string, args: unknown[]): Promise<any> {
        if (!this.eventCallbacks.has(id)) return this.invokeRemote(id, method, args);
        const previous = this.notificationTails.get(id) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() => this.invokeRemote(id, method, args));
        this.notificationTails.set(id, next);
        void next.finally(() => { if (this.notificationTails.get(id) === next) this.notificationTails.delete(id); }).catch(() => {});
        return next;
    }
    private trackInvocation<T>(pending: Promise<T>): Promise<T> {
        this.pendingInvocations.add(pending);
        void pending.finally(() => this.pendingInvocations.delete(pending)).catch(() => {});
        return pending;
    }
    /** Let pending unsubscribe calls finish before the transport destroys their view. */
    async whenIdle(): Promise<void> {
        while (this.pendingInvocations.size) await Promise.allSettled([...this.pendingInvocations]);
    }
    private async invokeRemote(id: string, method: string, args: unknown[]): Promise<any> {
        if (this.closed) throw new FSError('EIO', 'View connection is closed');
        if (!this.descriptors.has(id)) throw new FSError('ECAPABILITY', 'Capability was released');
        if (this.binaryCall(id, method, args)) return this.fileTransport!(id, method, args);
        const encoded = await Promise.all(args.map(arg => this.side === 'server' ? this.encode(arg, new Set()) : this.expose(arg)));
        const releaseArguments = this.side === 'server' ? this.lifetime.acquire(encoded) : undefined;
        const mode = this.schemas[this.descriptors.get(id)?.kind ?? '']?.methods[method];
        const callbacks = this.acquireCallbacks(encoded, subscriptionMode(mode));
        try {
            const released = this.retirementUpdates().map(update => (update as { $retired: string }).$retired);
            const reply = await this.send({ target: id, method, args: encoded, ...(released.length ? { released } : {}), ...(this.eventCallbacks.has(id) ? { notification: true } : {}) });
            this.applyUpdates(reply.updates);
            await this.waitUpdates(reply.updates);
            if (reply.error) { const error = new Error(reply.error.message); Object.assign(error, reply.error); throw error; }
            return this.decode(reply.value ?? null);
        } finally {
            for (const key of callbacks) this.releaseCallback(key, true);
            if (releaseArguments) { releaseArguments(); this.collectionNeeded = true; if (!this.operations) this.collectReleased(); }
        }
    }
    private acquireCallbacks(values: WireValue[], persistent: boolean): Set<string> {
        const callbacks = this.argumentCallbacks(values);
        for (const key of callbacks) {
            const use = this.callbackUses.get(key) ?? { active: 0, persistent: 0 };
            use.active++; if (persistent) use.persistent++;
            this.callbackUses.set(key, use);
        }
        return callbacks;
    }
    private releaseCallback(key: string, active: boolean, persistent = false): void {
        const use = this.callbackUses.get(key); if (!use) return;
        if (active) use.active--; if (persistent) use.persistent--;
        if (!use.active && !use.persistent) {
            const handle = this.handles.get(key); if (handle) this.ids.delete(handle.value);
            this.lifetime.release(key); this.retired.add(key); this.localRetirements.add(key);
            this.handles.delete(key); this.callbackUses.delete(key); this.eventCallbacks.delete(key); this.dirty.delete(key);
        }
    }
    private argumentCallbacks(values: WireValue[]): Set<string> {
        const ids = new Set<string>();
        const visit = (value: WireValue) => {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) { value.forEach(visit); return; }
            const id = typeof value.$ref === 'string' ? value.$ref : (value.$capability as unknown as Descriptor | undefined)?.id;
            if (id && this.handles.get(id)?.kind === 'Function') ids.add(id);
            Object.values(value).forEach(visit);
        };
        values.forEach(visit); return ids;
    }
    async handle(call: Call, refresh = true, binary?: ArrayBuffer, onRevision?: (revision: string | undefined) => void): Promise<Reply> {
        this.operations++;
        try {
            this.applyReleased(call.released);
            const handle = this.publicHandle(call);
            if (handle.schema.methods[call.method] === 'refresh') this.dirty.add(call.target);
            if (!this.query(call) && !subscriptionMode(handle.schema.methods[call.method]) && handle.schema.methods[call.method] !== 'iterator') {
                this.dirty.add(call.target); this.invalidate(...affectedDomains(this.schemas, handle.kind));
            }
            const { args, callbacks } = this.callArguments(call, handle, binary);
            if (onRevision) args[2] = { ...args[2], onRevision };
            if (handle.schema.methods[call.method] === 'lookup') this.remember(handle.value, call.method, args);
            let result = handle.kind === 'Function' ? await handle.value(...args) : handle.value[call.method](...args);
            if (handle.schema.methods[call.method] === 'iterator') result = iteratorCapability(result);
            else result = await result;
            if (!subscriptionMode(handle.schema.methods[call.method])) await Promise.all(callbacks);
            result = this.ownedResult(call, handle, result);
            return await this.reply(call, handle, result, refresh);
        } catch (error) {
            const cause = error as Error & { code?: string; field?: string; remoteCode?: string; requestId?: string; outcome?: 'committed' | 'not-committed' | 'unknown' };
            return { error: { name: cause.name ?? 'Error', message: cause.message ?? String(error), code: cause.code,
                ...(typeof cause.field === 'string' && cause.field.trim().length > 0 && cause.field.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(cause.field) ? {field: cause.field} : {}),
                ...(['committed', 'not-committed', 'unknown'].includes(cause.outcome ?? '') ? {outcome: cause.outcome} : {}),
                ...(typeof cause.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(cause.requestId) ? {requestId: cause.requestId} : {}),
                ...(typeof cause.remoteCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(cause.remoteCode) ? {remoteCode: cause.remoteCode} : {}) } };
        } finally {
            this.endOperation();
        }
    }
    private async reply(call: Call, handle: Handle, result: unknown, refresh: boolean): Promise<Reply> {
        const incremental = refresh && handle.kind !== 'Function' && !handle.schema.transaction;
        const snapshot = this.side === 'server' && handle.schema.resultSnapshots?.[call.method];
        if (snapshot) this.dirty.add(call.target);
        const value: WireValue = snapshot ? { $snapshot: { id: call.target, method: snapshot } }
            : await this.encode(result, new Set(), undefined, this.side === 'server' && handle.kind !== 'Function');
        if (subscriptionMode(handle.schema.methods[call.method])) this.lifetime.attach(call.target, value);
        else this.retain(value);
        if (this.operations === 1 && this.collectionNeeded) this.collectReleased();
        return { value, updates: incremental ? await this.refresh() : this.retirementUpdates() };
    }
    private applyReleased(ids: string[] = []): void {
        for (const id of ids) {
            if (!id.startsWith(this.side === 'client' ? 'server:' : 'client:')) throw new FSError('ECAPABILITY', 'Invalid released capability');
            this.retireRemote(id);
        }
    }
    private publicHandle(call: Call): Handle {
        if (this.closed) throw new FSError('EIO', 'View connection is closed');
        const handle = this.handles.get(call.target);
        if (!handle || handle.retired || !Object.hasOwn(handle.schema.methods, call.method)) {
            const remoteCode = !handle ? (this.localRetirements.has(call.target) ? 'RPC_CAPABILITY_RETIRED' : 'RPC_CAPABILITY_NOT_FOUND')
                : handle.retired ? 'RPC_CAPABILITY_RETIRED' : 'RPC_METHOD_NOT_EXPOSED';
            const method = /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(call.method) ? call.method : '[invalid]';
            const target = /^(?:client|server):(?:[a-f0-9-]{36}:)?[0-9]{1,10}$/.test(call.target) ? call.target : '[invalid]';
            throw Object.assign(new FSError('ECAPABILITY', `Unknown public capability: ${remoteCode}; method=${method}; target=${target}`), {remoteCode});
        }
        return handle;
    }
    private callArguments(call: Call, handle: Handle, binary?: ArrayBuffer): { args: any[]; callbacks: Promise<unknown>[] } {
        const callbacks: Promise<unknown>[] = [], subscription = subscriptionMode(handle.schema.methods[call.method]);
        const args = call.args.map((arg, index) => binary !== undefined && index === 1 ? binary
            : subscription ? this.decode(arg) : wrapCallbacks(this.decode(arg), callbacks, value => this.remoteIds.has(value)));
        if (subscription) for (let index = 0; index < args.length; index++) {
            const listener = args[index]; if (typeof listener !== 'function') continue;
            const remoteId = this.remoteIds.get(listener); if (remoteId) this.eventCallbacks.add(remoteId);
            args[index] = (...events: unknown[]) => {
                this.eventInvalidated(call.target); void Promise.resolve(listener(...events)).catch(this.report);
            };
        }
        return { args, callbacks };
    }
    private ownedResult(call: Call, handle: Handle, result: any): any {
        if (['dispose', 'release', 'return', 'close'].includes(call.method) || this.cleanupFunctions.has(handle.value)) {
            handle.retired = true; this.lifetime.release(call.target); this.collectionNeeded = true;
        }
        if (!subscriptionMode(handle.schema.methods[call.method]) || typeof result !== 'function') return result;
        const subscriptions = this.subscriptionReleases.get(call.target) ?? new Set();
        const owned = async () => {
            if (!this.releases.delete(owned)) return;
            subscriptions.delete(owned); await result();
        };
        this.releases.add(owned); subscriptions.add(owned); this.subscriptionReleases.set(call.target, subscriptions);
        this.cleanupFunctions.add(owned); return owned;
    }

    private retirementUpdates(): WireValue[] {
        const updates = [...this.retired].map(id => ({ $retired: id })); this.retired.clear(); return updates;
    }
    private collectReleased(): void {
        this.collectionNeeded = false; const live = this.lifetime.reachable();
        for (const [id, handle] of this.handles) {
            if (live.has(id) && !handle.retired) continue;
            for (const stop of this.subscriptionReleases.get(id) ?? []) void stop().catch(this.report);
            this.subscriptionReleases.delete(id);
            const release = this.observerReleases.get(id);
            if (release) { this.observerReleases.delete(id); this.releases.delete(release); release(); }
            this.ids.delete(handle.value); this.handles.delete(id); this.emitted.delete(id); this.dirty.delete(id);
            this.lookupArgs.delete(id); this.lifetime.forget(id); this.retired.add(id); this.localRetirements.add(id);
        }
    }
    async close(): Promise<void> {
        this.closed = true;
        for (const ready of this.updateWaiters) ready();
        await Promise.allSettled([...this.releases].map(release => release()));
        this.releases.clear(); this.pendingBindings.clear(); this.subscriptionReleases.clear(); this.observerReleases.clear(); this.lifetime.clear(); this.retired.clear(); this.localRetirements.clear(); this.remoteRetirements.clear(); this.handles.clear(); this.remote.clear();
        this.remoteCleanups.clear(); this.pendingUnsubscriptions.clear(); this.descriptors.clear(); this.emitted.clear(); this.dirty.clear(); this.pendingPatches.clear(); this.domains.clear();
        this.callbackUses.clear(); this.listeners.clear(); this.eventCallbacks.clear(); this.notificationTails.clear(); this.projectionsLoaded.clear(); this.lookupArgs.clear();
    }
}
function iteratorCapability(source: AsyncIterable<unknown>) {
    const iterator = source[Symbol.asyncIterator]();
    return { next: () => iterator.next(), return: () => iterator.return?.() ?? Promise.resolve({ done: true }) };
}

function wrapCallbacks(value: any, pending: Promise<unknown>[], capability: (value: object) => boolean): any {
    if (typeof value === 'function') return (...args: unknown[]) => {
        const result = Promise.resolve(value(...args)); pending.push(result); return result;
    };
    if (Array.isArray(value)) return value.map(item => wrapCallbacks(item, pending, capability));
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        // Capability methods are not arguments to the operation callback itself.
        if (capability(value)) return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wrapCallbacks(item, pending, capability)]));
    }
    return value;
}


function encodeBytes(value: ArrayBuffer | ArrayBufferView): WireValue {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return { $bytes: btoa(binary), typed: value instanceof Uint8Array };
}

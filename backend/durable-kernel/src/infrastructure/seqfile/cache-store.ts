import type { ISeqFileTransaction } from '@itookit/vfs-core';
import type { CacheEntry, CacheNamespace, CachePublish, CacheRead, CacheReceipt, CacheSpec, CacheManagementAction, CacheManagementReceipt } from '../../domain/cache';
import type { ResourceHandle } from '../../domain/types';
import { assertDurableValue } from '../../application/durability';
import { authorizeHandleTx, isTerminal, requireHandleTx, requireSessionTx, requireTaskTx } from './store-helpers';
import { appendEventTx, createId, decode, encode, handleKey, resourceKey, resourcesPath, taskPath } from './seqfile-core';

const namespaceKey = (id: string) => `cache/namespace/${id}`;
const entryPrefix = (id: string) => `cache/entry/${id}/`;
const entryKey = (id: string, key: string) => `${entryPrefix(id)}${encodeURIComponent(key)}`;
const opKey = (operationId: string) => `cache-operation/${encodeURIComponent(operationId)}`;
const ownerIndexPrefix = (taskId: string) => `cache/owner/${encodeURIComponent(taskId)}/`;
const ownerIndexKey = (taskId: string, namespaceId: string) => `${ownerIndexPrefix(taskId)}${namespaceId}`;
const ownerIndexVersionKey = 'cache/owner-index-version';

function required(value: string, name: string): void {
    if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`Invalid cache ${name}`);
}

function expiresAt(ttlMs: number, now: number): number {
    const expires = now + ttlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(expires) || expires > Number.MAX_SAFE_INTEGER) throw new Error('Invalid cache TTL');
    return expires;
}

function nextGeneration(generation: number): number {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation === Number.MAX_SAFE_INTEGER) throw new Error('Cache generation exhausted or invalid');
    return generation + 1;
}

async function liveTask(tx: ISeqFileTransaction, root: string, taskId: string) {
    const task = await requireTaskTx(tx, root, taskId);
    if (isTerminal(task.status)) throw new Error('Task is terminal');
    const session = await requireSessionTx(tx, root);
    if (session.status !== 'open' && session.status !== 'suspended' && session.status !== 'suspending' && !(session.status === 'closing' && session.closeMode === 'drain')) throw new Error('Session is closed');
    return task;
}

export async function createCacheTx(tx: ISeqFileTransaction, root: string, taskId: string, spec: CacheSpec): Promise<{ namespace: CacheNamespace; handle: ResourceHandle }> {
    const task = await liveTask(tx, root, taskId);
    required(spec.name, 'name');
    if (spec.scope && !['step', 'task', 'session'].includes(spec.scope)) throw new Error('Unsupported cache scope');
    if (spec.usage && !['reusable', 'single-use'].includes(spec.usage)) throw new Error('Unsupported cache usage');
    const maxEntries = spec.maxEntries ?? 256, maxBytes = spec.maxBytes ?? 4 * 1024 * 1024;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('Cache quota is invalid');
    if (spec.ttlMs !== undefined) expiresAt(spec.ttlMs, Date.now());
    await ensureCacheOwnerIndex(tx, resourcesPath(root));
    const id = createId('cache');
    const namespace: CacheNamespace = { id, ownerTaskId: taskId, stepNumber: task.stepNumber ?? 0,
        name: spec.name, scope: spec.scope ?? 'task', usage: spec.usage ?? 'reusable', generation: 1,
        ttlMs: spec.ttlMs, maxEntries, maxBytes, createdAt: Date.now() };
    const handle: ResourceHandle = { id: createId('handle'), resourceId: id, holderTaskId: taskId,
        generation: 1, rights: ['read', 'write', 'grant', 'admin'] };
    await tx.setEntry(resourcesPath(root), resourceKey(id), encode({ id, sessionId: task.sessionId, kind: 'cache',
        uri: `cache://${id}`, generation: 1, createdAt: namespace.createdAt }));
    await tx.setEntry(resourcesPath(root), handleKey(handle.id), encode(handle));
    await tx.setEntry(resourcesPath(root), namespaceKey(id), encode(namespace));
    // Rebuildable owner index: lets terminal cleanup find a Task's namespaces without
    // scanning the whole resources.seq on every Task completion.
    await tx.setEntry(resourcesPath(root), ownerIndexKey(taskId, id), encode({ id }));
    await appendEventTx(tx, root, task.sessionId, taskId, 'cache.created', { namespaceId: id, scope: namespace.scope });
    return { namespace, handle };
}

async function authorized(tx: ISeqFileTransaction, root: string, taskId: string, handleId: string, right: 'read' | 'write' | 'admin'): Promise<CacheNamespace> {
    const handle = await requireHandleTx(tx, root, handleId);
    if (handle.holderTaskId !== taskId) throw new Error('Cache handle holder mismatch');
    const resource = await authorizeHandleTx(tx, root, handle, right);
    if (resource.kind !== 'cache') throw new Error('Resource is not a cache');
    const raw = await tx.getEntry(resourcesPath(root), namespaceKey(resource.id));
    if (!raw) throw new Error('Cache namespace not found');
    const namespace = decode<CacheNamespace>(raw);
    if (namespace.scope !== 'session') {
        const owner = await requireTaskTx(tx, root, namespace.ownerTaskId);
        if (isTerminal(owner.status)) throw new Error('Cache owner is terminal');
        if (namespace.scope === 'step' && (owner.stepNumber ?? 0) !== namespace.stepNumber) throw new Error('Cache step expired');
    }
    return namespace;
}

async function previous<T>(tx: ISeqFileTransaction, root: string, taskId: string, operationId: string, request: unknown): Promise<T | undefined> {
    required(operationId, 'operationId');
    const raw = await tx.getEntry(taskPath(root, taskId), opKey(operationId));
    if (!raw) return undefined;
    const receipt = decode<{ request: string; result: T }>(raw);
    if (receipt.request !== encode(request)) throw new Error('Cache operation conflict');
    return receipt.result;
}
async function record(tx: ISeqFileTransaction, root: string, taskId: string, operationId: string, request: unknown, result: unknown) {
    await tx.setEntry(taskPath(root, taskId), opKey(operationId), encode({ request: encode(request), result }));
}

export async function manageCacheTx(tx: ISeqFileTransaction, root: string, taskId: string, action: CacheManagementAction): Promise<CacheManagementReceipt> {
    const old = await previous<CacheManagementReceipt>(tx, root, taskId, action.operationId, action);
    if (old) return old;
    let result: CacheManagementReceipt;
    if (action.type === 'cache-create') {
        result = { operationId: action.operationId, type: 'created', ...await createCacheTx(tx, root, taskId, action.spec) };
    } else if (action.type === 'cache-invalidate') {
        result = { operationId: action.operationId, type: 'invalidated', namespace: await invalidateCacheTx(tx, root, taskId, action.handleId, action.expectedGeneration) };
    } else {
        result = { operationId: action.operationId, type: 'renewed', namespace: await renewCacheTx(tx, root, taskId, action.handleId, action.expectedGeneration, action.ttlMs) };
    }
    await record(tx, root, taskId, action.operationId, action, result);
    return result;
}

export async function publishCacheTx(tx: ISeqFileTransaction, root: string, taskId: string, request: CachePublish): Promise<CacheEntry> {
    const task = await liveTask(tx, root, taskId);
    assertDurableValue(request.value, 'Cache value');
    required(request.key, 'key'); required(request.fingerprint, 'fingerprint');
    const operation = { type: 'publish', ...request };
    const old = await previous<CacheEntry>(tx, root, taskId, request.operationId, operation);
    if (old) return old;
    const namespace = await authorized(tx, root, taskId, request.handleId, 'write');
    if (namespace.generation !== request.expectedGeneration) throw new Error('Cache generation conflict');
    const path = resourcesPath(root), key = entryKey(namespace.id, request.key);
    const raw = await tx.getEntry(path, key), current = raw ? decode<CacheEntry>(raw) : undefined;
    const currentVersion = current?.generation === namespace.generation ? current.version : undefined;
    if (request.expectedVersion !== undefined && (request.expectedVersion === null ? currentVersion !== undefined : currentVersion !== request.expectedVersion)) throw new Error('Cache version conflict');
    // Keep the publication sequence when quota eviction removes the value (avoid ABA).
    const versionKey = `cache/version/${namespace.id}/${encodeURIComponent(request.key)}`;
    const savedVersion = await tx.getEntry(path, versionKey);
    const version = Math.max(current?.version ?? 0, savedVersion === null ? 0 : Number(savedVersion)) + 1;
    if (!Number.isSafeInteger(version) || version <= 0) throw new Error('Cache version exhausted or invalid');
    const now = Date.now();
    const entry: CacheEntry = { key: request.key, fingerprint: request.fingerprint, generation: namespace.generation,
        version, value: request.value, createdAt: now,
        expiresAt: namespace.ttlMs === undefined ? undefined : expiresAt(namespace.ttlMs, now) };
    const rows: Array<{ key: string; entry: CacheEntry }> = [];
    await tx.walkEntries(path, row => { if (row.key !== key) rows.push({ key: row.key, entry: decode(row.value) }); return true; }, { keyPrefix: entryPrefix(namespace.id) });
    const bytes = (value: unknown) => new TextEncoder().encode(encode(value)).byteLength;
    if (bytes(entry) > namespace.maxBytes) throw new Error('Cache entry exceeds byte quota');
    let total = bytes(entry), count = 1;
    rows.sort((a, b) => b.entry.createdAt - a.entry.createdAt);
    for (const row of rows) {
        total += bytes(row.entry); count++;
        if (row.entry.generation !== namespace.generation || (row.entry.expiresAt ?? Infinity) <= now || count > namespace.maxEntries || total > namespace.maxBytes) {
            await tx.deleteEntry(path, row.key); total -= bytes(row.entry); count--;
        }
    }
    await tx.setEntry(path, versionKey, String(version));
    await tx.setEntry(path, key, encode(entry));
    await record(tx, root, taskId, request.operationId, operation, entry);
    await appendEventTx(tx, root, task.sessionId, taskId, 'cache.published', { namespaceId: namespace.id, key: request.key, version: entry.version });
    return entry;
}

export async function readCacheTx(tx: ISeqFileTransaction, root: string, taskId: string, request: CacheRead): Promise<CacheReceipt> {
    const task = await liveTask(tx, root, taskId), operation = { type: 'read', ...request };
    const old = await previous<CacheReceipt>(tx, root, taskId, request.operationId, operation);
    if (old) return old;
    if (request.maxAgeMs !== undefined && (!Number.isFinite(request.maxAgeMs) || request.maxAgeMs < 0)) throw new Error('Invalid cache max age');
    if (request.mode !== undefined && !['prefer-cache', 'cache-only', 'refresh', 'bypass'].includes(request.mode)) throw new Error('Invalid cache mode');
    if (!Array.isArray(request.sources)) throw new Error('Invalid cache sources');
    const namespaces: CacheNamespace[] = [];
    for (const source of request.sources) {
        if (!source || typeof source !== 'object') throw new Error('Invalid cache source');
        required(source.handleId, 'handleId'); required(source.key, 'key'); required(source.fingerprint, 'fingerprint');
        if (source.expectedVersion !== undefined && (!Number.isSafeInteger(source.expectedVersion) || source.expectedVersion < 1)) throw new Error('Invalid cache expected version');
        namespaces.push(await authorized(tx, root, taskId, source.handleId, 'read'));
    }
    let result: CacheReceipt = { operationId: request.operationId, status: 'miss', observedAt: Date.now() };
    if (request.mode === 'bypass' || request.mode === 'refresh') result.status = 'bypass';
    else for (const [index, source] of request.sources.entries()) {
        const namespace = namespaces[index];
        const key = entryKey(namespace.id, source.key), raw = await tx.getEntry(resourcesPath(root), key);
        if (!raw) continue;
        const entry = decode<CacheEntry>(raw), now = Date.now();
        if (entry.generation !== namespace.generation || entry.fingerprint !== source.fingerprint || entry.consumedBy
            || (source.expectedVersion !== undefined && entry.version !== source.expectedVersion)
            || (entry.expiresAt ?? Infinity) <= now || (request.maxAgeMs !== undefined && now - entry.createdAt > request.maxAgeMs)) continue;
        result = { operationId: request.operationId, status: 'hit', observedAt: now, value: entry.value,
            namespaceId: namespace.id, generation: namespace.generation, entryVersion: entry.version };
        if (namespace.usage === 'single-use') await tx.setEntry(resourcesPath(root), key, encode({ ...entry, consumedBy: `${taskId}/${request.operationId}` }));
        break;
    }
    // The value is copied into the durable task receipt in the same transaction
    // as a single-use take. Cache eviction never deletes this recovery input.
    await record(tx, root, taskId, request.operationId, operation, result);
    await appendEventTx(tx, root, task.sessionId, taskId, 'cache.read', { operationId: request.operationId, status: result.status, namespaceId: result.namespaceId });
    return result;
}

export async function invalidateCacheTx(tx: ISeqFileTransaction, root: string, taskId: string, handleId: string, expectedGeneration: number): Promise<CacheNamespace> {
    await liveTask(tx, root, taskId);
    const current = await authorized(tx, root, taskId, handleId, 'admin');
    if (current.generation !== expectedGeneration) throw new Error('Cache generation conflict');
    const next = { ...current, generation: nextGeneration(current.generation) };
    await tx.setEntry(resourcesPath(root), namespaceKey(current.id), encode(next));
    return next;
}

/** Renew live entries only. Expired values and consumed single-use entries are never resurrected. */
export async function renewCacheTx(tx: ISeqFileTransaction, root: string, taskId: string, handleId: string, expectedGeneration: number, ttlMs: number): Promise<CacheNamespace> {
    const task = await liveTask(tx, root, taskId);
    const now = Date.now(), deadline = expiresAt(ttlMs, now);
    const current = await authorized(tx, root, taskId, handleId, 'admin');
    if (current.generation !== expectedGeneration) throw new Error('Cache generation conflict');
    const next = { ...current, ttlMs, generation: nextGeneration(current.generation) };
    const entries: Array<{ key: string; value: CacheEntry }> = [];
    await tx.walkEntries(resourcesPath(root), row => { entries.push({ key: row.key, value: decode(row.value) }); return true; }, { keyPrefix: entryPrefix(current.id) });
    for (const entry of entries) {
        if (entry.value.generation !== current.generation || (entry.value.expiresAt ?? Infinity) <= now || entry.value.consumedBy) continue;
        await tx.setEntry(resourcesPath(root), entry.key, encode({ ...entry.value, generation: next.generation, expiresAt: deadline }));
    }
    await tx.setEntry(resourcesPath(root), namespaceKey(current.id), encode(next));
    await appendEventTx(tx, root, task.sessionId, taskId, 'cache.renewed', { namespaceId: current.id, generation: next.generation, ttlMs });
    return next;
}

/**
 * Drop the cache namespaces a Task owns once it reaches a terminal state.
 *
 * Step visibility already expires when the logical step changes. Reclaim remaining
 * `step`/`task` namespaces at Task terminal, while
 * `session` scope lives until the Session closes. Artifacts, Effect idempotency facts
 * and `cache-operation` receipts are deliberately left in place — cleanup only removes
 * the namespace record, its entries, its publication sequence and its handle/resource.
 * Returns the removed namespace ids for the `cache.cleaned` event payload.
 */
export async function cleanupTaskCachesTx(tx: ISeqFileTransaction, root: string, sessionId: string, taskId: string): Promise<string[]> {
    const path = resourcesPath(root);
    const namespaces = await expirableNamespaces(tx, path, taskId);
    if (namespaces.length === 0) return [];
    const owned = new Set(namespaces.map(namespace => namespace.id));
    const handleIds: string[] = [];
    await tx.walkEntries(path, row => {
        const handle = decode<ResourceHandle>(row.value);
        if (owned.has(handle.resourceId)) handleIds.push(handle.id);
        return true;
    }, { keyPrefix: 'handle/' });
    for (const namespace of namespaces) await deleteCacheNamespace(tx, path, namespace);
    for (const handleId of handleIds) await tx.deleteEntry(path, handleKey(handleId));
    const removed = [...owned];
    await appendEventTx(tx, root, sessionId, taskId, 'cache.cleaned', { namespaceIds: removed });
    return removed;
}

/** `session` scope outlives the owning Task, so it keeps its namespace and index entry. */
async function expirableNamespaces(tx: ISeqFileTransaction, path: string, taskId: string): Promise<CacheNamespace[]> {
    await ensureCacheOwnerIndex(tx, path);
    const indexed: string[] = [];
    await tx.walkEntries(path, row => {
        const id = decode<{ id: string }>(row.value).id;
        if (typeof id !== 'string' || !id || row.key !== ownerIndexKey(taskId, id)) throw new Error('Cache owner index mismatch');
        indexed.push(id);
        return true;
    }, { keyPrefix: ownerIndexPrefix(taskId) });
    const namespaces: CacheNamespace[] = [];
    for (const id of indexed) {
        const raw = await tx.getEntry(path, namespaceKey(id));
        if (!raw) continue;
        const namespace = decode<CacheNamespace>(raw);
        if (namespace.id !== id || namespace.ownerTaskId !== taskId) throw new Error('Cache owner index mismatch');
        if (namespace.scope !== 'session') namespaces.push(namespace);
    }
    return namespaces;
}

/** Legacy namespaces predate the index; rebuild once, atomically with its version marker. */
async function ensureCacheOwnerIndex(tx: ISeqFileTransaction, path: string): Promise<void> {
    const version = await tx.getEntry(path, ownerIndexVersionKey);
    if (version === '1') return;
    if (version !== null) throw new Error('Unsupported cache owner index version');
    const namespaces: CacheNamespace[] = [], obsolete: string[] = [];
    await tx.walkEntries(path, row => {
        const namespace = decode<CacheNamespace>(row.value);
        if (typeof namespace.ownerTaskId !== 'string' || !namespace.ownerTaskId
            || typeof namespace.id !== 'string' || !namespace.id || row.key !== namespaceKey(namespace.id)
            || !['step', 'task', 'session'].includes(namespace.scope)) throw new Error('Invalid cache namespace');
        namespaces.push(namespace); return true;
    }, { keyPrefix: 'cache/namespace/' });
    await tx.walkEntries(path, row => { obsolete.push(row.key); return true; }, { keyPrefix: 'cache/owner/' });
    for (const key of obsolete) await tx.deleteEntry(path, key);
    for (const namespace of namespaces) {
        await tx.setEntry(path, ownerIndexKey(namespace.ownerTaskId, namespace.id), encode({ id: namespace.id }));
    }
    await tx.setEntry(path, ownerIndexVersionKey, '1');
}

async function deleteCacheNamespace(tx: ISeqFileTransaction, path: string, namespace: CacheNamespace): Promise<void> {
    for (const prefix of [`cache/entry/${namespace.id}/`, `cache/version/${namespace.id}/`]) {
        const keys: string[] = [];
        await tx.walkEntries(path, row => { keys.push(row.key); return true; }, { keyPrefix: prefix });
        for (const key of keys) await tx.deleteEntry(path, key);
    }
    await tx.deleteEntry(path, namespaceKey(namespace.id));
    await tx.deleteEntry(path, resourceKey(namespace.id));
    await tx.deleteEntry(path, ownerIndexKey(namespace.ownerTaskId, namespace.id));
}

/**
 * Physical reclaim of every cache namespace of a Session, including `session` scope, once
 * the Session reaches `closed` (Cache §10 `until-session-closed`). `closed` is checked to
 * have no unfinished Task before this runs, and cache operations refuse closed Sessions,
 * so no reader can hold a live reference while the namespaces are dropped.
 */
export async function cleanupSessionCachesTx(tx: ISeqFileTransaction, root: string, sessionId: string): Promise<string[]> {
    const path = resourcesPath(root);
    const namespaces: CacheNamespace[] = [];
    await tx.walkEntries(path, row => { namespaces.push(decode<CacheNamespace>(row.value)); return true; }, { keyPrefix: 'cache/namespace/' });
    await tx.deleteEntry(path, ownerIndexVersionKey);
    if (namespaces.length === 0) return [];
    const owned = new Set(namespaces.map(namespace => namespace.id));
    const handleIds: string[] = [];
    await tx.walkEntries(path, row => {
        const handle = decode<ResourceHandle>(row.value);
        if (owned.has(handle.resourceId)) handleIds.push(handle.id);
        return true;
    }, { keyPrefix: 'handle/' });
    for (const namespace of namespaces) await deleteCacheNamespace(tx, path, namespace);
    for (const handleId of handleIds) await tx.deleteEntry(path, handleKey(handleId));
    const removed = [...owned];
    await appendEventTx(tx, root, sessionId, undefined, 'cache.cleaned', { namespaceIds: removed, scope: 'session' });
    return removed;
}

export async function listCachesTx(tx: ISeqFileTransaction, root: string, taskId: string): Promise<Array<{ namespace: CacheNamespace; handleId: string }>> {
    await liveTask(tx, root, taskId);
    const handles: ResourceHandle[] = [];
    await tx.walkEntries(resourcesPath(root), row => { const handle = decode<ResourceHandle>(row.value); if (handle.holderTaskId === taskId) handles.push(handle); return true; }, { keyPrefix: 'handle/' });
    const result: Array<{ namespace: CacheNamespace; handleId: string }> = [];
    for (const handle of handles) {
        if (!await tx.getEntry(resourcesPath(root), namespaceKey(handle.resourceId))) continue;
        try { result.push({ namespace: await authorized(tx, root, taskId, handle.id, 'read'), handleId: handle.id }); }
        catch { /* Expired/revoked grants are not visible. */ }
    }
    return result;
}

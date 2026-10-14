import type { ISeqFileTransaction } from '@itookit/vfs-core';
import type { ManagedResource, ManagedHandle, ResourceClaim, ResourceCommand, ResourceRequestSnapshot, ResourceResult, ManagedResourceRef, ManagedGrant, ResourceCleanup, ManagedResourceAdapter, ResourceCleanupReceipt, ResourceQuery, ResourcePage, ResourceRequestInfo, ManagedAuthority, ResourceAuthority, AuthorityClaim } from '../../domain/resource-api';
import type { ResolvedStorageBinding, ResourceRight } from '../../domain/types';
import { assertDurableValue } from '../../application/durability';
import { createId, decode, encode, ensureSeqFile, resourcesPath, transaction } from './seqfile-core';
import { appendEventTx, indexTask, isTerminal, requireSessionTx, readTaskTx, requireTaskTx, unregisterTaskWaitTx, wakeFromPendingEvents, writeTaskTx } from './store-helpers';

export interface ResourceActor { sessionId?: string; taskId?: string; }
interface StoredResource extends ManagedResource { creatorTaskId?: string; }
interface RequestRow extends ResourceRequestSnapshot {
    fingerprint?: string;
    command?: ResourceCommand;
    actor: ResourceActor;
    actorRoot?: string;
    sequence: number;
    notified?: boolean;
}
export interface PreparedResourceCommand {
    authority: ResolvedStorageBinding;
    actorRoot?: string;
    actor: ResourceActor;
    scope: string;
    command: ResourceCommand;
}
const key = (kind: string, id: string) => `managed/${kind}/${encodeURIComponent(id)}`;
const subject = (actor: ResourceActor) => JSON.stringify([actor.sessionId ?? null, actor.taskId ?? null]);
const requestKey = (actor: ResourceActor, id: string) => key('request', JSON.stringify([subject(actor), id]));
const accessKey = (id: string, session: string) => key('access', JSON.stringify([id, session]));
export const resourceScope = (actor: ResourceActor) => actor.sessionId ? `session:${actor.sessionId}` : 'kernel';
const rightNames: ResourceRight[] = ['read', 'write', 'execute', 'grant', 'admin'];
class ResourceCommandError extends Error {}
function requireText(value: string) { if (typeof value !== 'string' || !value.trim()) throw new ResourceCommandError('Resource identity/name is required'); }
function positive(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw new ResourceCommandError('Resource quantity must be a positive safe integer'); }
function rights(values: ResourceRight[]) {
    if (!Array.isArray(values) || !values.length || values.some(v => !rightNames.includes(v))) throw new ResourceCommandError('Invalid resource rights');
    return [...new Set(values)];
}
async function read<T>(tx: ISeqFileTransaction, path: string, name: string): Promise<T | undefined> {
    const raw = await tx.getEntry(path, name); return raw === null ? undefined : decode<T>(raw);
}
async function schemaTx(tx: ISeqFileTransaction, path: string, create = false) {
    const schema = await tx.getEntry(path, 'managed/schema');
    if (schema !== null && schema !== '1' && schema !== '2' && schema !== '3') throw new ResourceCommandError('Unsupported managed resource schema; migration required');
    if (create && (schema === null || schema === '1')) await tx.setEntry(path, 'managed/schema', '2');
}
const authorityKey = (id: string) => key('authority', id);
function requireEpoch(value: number, message: string) {
    if (!Number.isSafeInteger(value) || value < 0) throw new ResourceCommandError(message);
}
/**
 * CAS the authority `ownerEpoch`. A first claim needs no expected epoch; a takeover must
 * present the epoch it observed, so two leaders cannot both believe they own the authority.
 * The local binding marker is immutable. Cross-store exclusivity requires a broker.
 */
async function claimAuthorityTx(tx: ISeqFileTransaction, path: string, authorityId: string, claim: AuthorityClaim): Promise<ManagedAuthority> {
    requireText(authorityId);
    if (claim.ownerId !== undefined) requireText(claim.ownerId);
    if (claim.binding !== undefined) requireText(claim.binding);
    if (claim.serviceEndpoint !== undefined) requireText(claim.serviceEndpoint);
    if (claim.expectedEpoch !== undefined) requireEpoch(claim.expectedEpoch, 'Authority expected epoch must be a non-negative safe integer');
    await tx.setEntry(path, 'managed/schema', '3');
    const recordedBinding = claim.binding ?? path;
    const current = await read<ManagedAuthority>(tx, path, authorityKey(authorityId));
    if (!current) {
        if (claim.expectedEpoch !== undefined) throw new ResourceCommandError(`Unknown authority ${authorityId}; the first claim takes no expected epoch`);
        const created: ManagedAuthority = { authorityId, ownerEpoch: 1, status: 'active', updatedAt: Date.now(), binding: recordedBinding,
            ...(claim.ownerId ? { ownerId: claim.ownerId } : {}), ...(claim.serviceEndpoint ? { serviceEndpoint: claim.serviceEndpoint } : {}) };
        await tx.setEntry(path, authorityKey(authorityId), encode(created));
        return created;
    }
    if (claim.binding !== undefined && current.binding !== undefined && claim.binding !== current.binding)
        throw new ResourceCommandError(`Authority ${authorityId} is bound to another storage binding; migration requires an explicit switch`);
    if (claim.expectedEpoch !== current.ownerEpoch)
        throw new ResourceCommandError(`Authority epoch conflict: ${authorityId} is owned by ${current.ownerId ?? '(unknown)'} at epoch ${current.ownerEpoch}`);
    if (!Number.isSafeInteger(current.ownerEpoch) || current.ownerEpoch < 1) throw new ResourceCommandError('Invalid authority epoch');
    if (current.ownerEpoch === Number.MAX_SAFE_INTEGER) throw new ResourceCommandError('Authority epoch exhausted');
    const next: ManagedAuthority = { ...current, binding: current.binding ?? recordedBinding, ownerEpoch: current.ownerEpoch + 1, updatedAt: Date.now(),
        ...(claim.ownerId ? { ownerId: claim.ownerId } : {}), ...(claim.serviceEndpoint ? { serviceEndpoint: claim.serviceEndpoint } : {}) };
    await tx.setEntry(path, authorityKey(authorityId), encode(next));
    return next;
}
/** Refuse a command whose presented epoch no longer owns the authority. */
async function assertAuthorityEpochTx(tx: ISeqFileTransaction, path: string, fence: ResourceAuthority) {
    requireText(fence.authorityId);
    if (!Number.isSafeInteger(fence.epoch) || fence.epoch < 1) throw new ResourceCommandError('Authority epoch must be a positive safe integer');
    const current = await read<ManagedAuthority>(tx, path, authorityKey(fence.authorityId));
    if (!current) throw new ResourceCommandError(`Unknown authority ${fence.authorityId}`);
    if (current.status !== 'active') throw new ResourceCommandError(`Authority ${fence.authorityId} is not active`);
    if (current.ownerEpoch !== fence.epoch)
        throw new ResourceCommandError(`Authority epoch conflict: ${fence.authorityId} is owned by ${current.ownerId ?? '(unknown)'} at epoch ${current.ownerEpoch}`);
}
async function rows<T>(tx: ISeqFileTransaction, path: string, kind: string): Promise<T[]> {
    const result: T[] = [];
    await tx.walkEntries(path, row => { result.push(decode<T>(row.value)); return true; }, { keyPrefix: `managed/${kind}/` });
    return result;
}
function fingerprint(value: unknown): string {
    const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
    return JSON.stringify(sort(JSON.parse(encode(value))));
}
async function resourceTx(tx: ISeqFileTransaction, p: PreparedResourceCommand, ref: ManagedResourceRef) {
    if (ref.scope !== p.scope) throw new ResourceCommandError('Resource scope mismatch');
    const r = await read<StoredResource>(tx, resourcesPath(p.authority.rootPath), key('resource', ref.id));
    if (!r) throw new ResourceCommandError('Managed resource not found');
    if (r.authorityId !== undefined && p.command.type !== 'read') {
        if (p.command.authority?.authorityId !== r.authorityId) throw new ResourceCommandError('Resource authority mismatch');
        await assertAuthorityEpochTx(tx, resourcesPath(p.authority.rootPath), p.command.authority);
    }
    return r;
}
function isOwner(p: PreparedResourceCommand, r: StoredResource) {
    return resourceScope(p.actor) === r.ref.scope && (!p.actor.taskId || r.creatorTaskId === p.actor.taskId);
}
async function grantTx(tx: ISeqFileTransaction, path: string, id: string, sessionId: string): Promise<ManagedGrant> {
    const value = await read<ManagedGrant | ResourceRight[]>(tx, path, accessKey(id, sessionId));
    if (value && !Array.isArray(value)) return value;
    const granted = value ?? [];
    return { id: `grant:${id}:${sessionId}`, resourceId: id, sessionId, revision: 0,
        rights: granted, epochs: {}, state: granted.length ? 'active' : 'revoked' };
}
function activeResource(r: StoredResource) {
    if (r.state && r.state !== 'active') throw new ResourceCommandError('Resource is closing or tombstoned');
}
async function allowed(tx: ISeqFileTransaction, p: PreparedResourceCommand, r: StoredResource): Promise<ResourceRight[]> {
    if (isOwner(p, r)) return rightNames;
    return p.actor.sessionId ? (await grantTx(tx, resourcesPath(p.authority.rootPath), r.ref.id, p.actor.sessionId)).rights : [];
}
async function handleTx(tx: ISeqFileTransaction, p: PreparedResourceCommand, supplied: ManagedHandle, needed?: ResourceRight) {
    if (!p.actorRoot || !p.actor.sessionId) throw new ResourceCommandError('Session resource handle required');
    const h = await read<ManagedHandle>(tx, resourcesPath(p.actorRoot), key('handle', supplied.id));
    if (!h || h.ref.scope !== p.scope || h.ref.id !== supplied.ref.id || h.sessionId !== p.actor.sessionId
        || (p.actor.taskId && h.taskId !== p.actor.taskId)) throw new ResourceCommandError('Resource handle holder mismatch');
    if (needed && (h.closed || !h.rights.includes(needed))) throw new ResourceCommandError('Resource handle denied');
    const r = await resourceTx(tx, p, h.ref);
    if (needed) {
        activeResource(r);
        if (!(await allowed(tx, p, r)).includes(needed)) throw new ResourceCommandError('Resource grant denied');
        if (!isOwner(p, r)) {
            const grant = await grantTx(tx, resourcesPath(p.authority.rootPath), r.ref.id, h.sessionId);
            if ((h.grantEpochs?.[needed] ?? 0) !== (grant.epochs[needed] ?? 0)) throw new ResourceCommandError('Resource grant epoch revoked; reopen the handle');
        }
    }
    return { h, r };
}
async function claimsTx(tx: ISeqFileTransaction, path: string, id: string) {
    return (await rows<ResourceClaim>(tx, path, 'claim')).filter(c => c.ref.id === id && !c.released);
}
async function finishTx(tx: ISeqFileTransaction, p: PreparedResourceCommand, row: RequestRow) {
    if (row.status !== 'pending' && !row.notified && row.actor.taskId && row.actorRoot) {
        const task = await readTaskTx(tx, row.actorRoot, row.actor.taskId);
        if (task && !isTerminal(task.status)) {
            const snapshot: ResourceRequestSnapshot = { id: row.id, scope: row.scope, status: row.status,
                ...(row.result !== undefined ? { result: row.result } : {}), ...(row.error ? { error: row.error } : {}) };
            const next = wakeFromPendingEvents({ ...task, version: task.version + 1, updatedAt: Date.now(),
                pendingEvents: [...task.pendingEvents, { type: 'resource-result' as const, receipt: snapshot }] });
            if (next.status === 'ready') await unregisterTaskWaitTx(tx, row.actorRoot, task);
            await writeTaskTx(tx, row.actorRoot, next); await indexTask(tx, row.actorRoot, next);
        }
        row.notified = true;
    }
    await tx.setEntry(resourcesPath(p.authority.rootPath), requestKey(row.actor, row.id), encode(row));
}

async function beginReleaseTx(tx: ISeqFileTransaction, path: string, r: StoredResource, claim: ResourceClaim): Promise<ResourceClaim> {
    if (claim.released || claim.state === 'cleanup-pending') return claim;
    if (!r.physical) {
        const next: ResourceClaim = { ...claim, state: 'released', released: true };
        await tx.setEntry(path, key('claim', claim.id), encode(next));
        return next;
    }
    const id = createId('cleanup'), epoch = (claim.epoch ?? 1) + 1;
    const operation: ResourceCleanup = { id, ref: r.ref, claimId: claim.id, epoch, physical: r.physical,
        status: 'pending', attempts: 0, nextAttemptAt: Date.now() };
    const next: ResourceClaim = { ...claim, state: 'cleanup-pending', cleanupId: id, epoch };
    await tx.setEntry(path, key('claim', claim.id), encode(next));
    await tx.setEntry(path, key('cleanup', id), encode(operation));
    return next;
}

async function settleLifecycleTx(tx: ISeqFileTransaction, authority: ResolvedStorageBinding) {
    const path = resourcesPath(authority.rootPath);
    for (const resource of await rows<StoredResource>(tx, path, 'resource')) {
        if (resource.state !== 'closing' || (await claimsTx(tx, path, resource.ref.id)).length) continue;
        if (resource.physical) {
            const id = `destroy:${resource.ref.id}`;
            const operation = await read<ResourceCleanup>(tx, path, key('cleanup', id));
            if (!operation) {
                await tx.setEntry(path, key('cleanup', id), encode({ id, ref: resource.ref, epoch: resource.version,
                    physical: resource.physical, status: 'pending', attempts: 0, nextAttemptAt: Date.now() } satisfies ResourceCleanup));
                continue;
            }
            if (operation.status !== 'succeeded') continue;
        }
        await tx.setEntry(path, key('resource', resource.ref.id), encode({ ...resource, state: 'tombstoned', version: resource.version + 1 }));
    }
    const requests = await rows<RequestRow>(tx, path, 'request');
    for (const row of requests) {
        if (row.status !== 'pending') continue;
        const c = row.command;
        if (c?.type === 'release') {
            const claim = await read<ResourceClaim>(tx, path, key('claim', c.claim.id));
            if (!claim?.released) continue;
            row.result = claim;
        } else if (c?.type === 'destroy') {
            const resource = await read<StoredResource>(tx, path, key('resource', c.ref.id));
            if (resource?.state !== 'tombstoned') continue;
            row.result = resource;
        } else continue;
        row.status = 'succeeded';
        await finishTx(tx, { authority, scope: row.scope, actor: row.actor, actorRoot: row.actorRoot, command: c }, row);
    }
    return requests;
}

/** Called inside the same transaction as the owning Decision, or by the host facade. */
export async function executeResourceTx(tx: ISeqFileTransaction, p: PreparedResourceCommand): Promise<ResourceRequestSnapshot> {
    const c = p.command, path = resourcesPath(p.authority.rootPath);
    await schemaTx(tx, path, true);
    requireText(c.requestId); assertDurableValue(c, 'Resource command');
    const old = await read<RequestRow>(tx, path, requestKey(p.actor, c.requestId));
    if (old) {
        if (old.fingerprint && old.fingerprint !== fingerprint(c)) throw new ResourceCommandError('Resource request identity conflict');
        return old;
    }
    // An accepted request replays its recorded result; only a *new* write is fenced, so a
    // leader takeover never rewrites facts that the previous leader already committed.
    if (c.authority) await assertAuthorityEpochTx(tx, path, c.authority);
    const cleanup = c.type === 'release' || c.type === 'close' || c.type === 'destroy' || c.type === 'revoke';
    if (p.actorRoot) {
        await schemaTx(tx, resourcesPath(p.actorRoot), true);
        const s = await requireSessionTx(tx, p.actorRoot);
        if (s.id !== p.actor.sessionId) throw new ResourceCommandError('Resource actor mismatch');
        if (!cleanup && s.status !== 'open') throw new ResourceCommandError('Resource session is not open');
        if (p.actor.taskId && !cleanup && isTerminal((await requireTaskTx(tx, p.actorRoot, p.actor.taskId)).status)) throw new ResourceCommandError('Resource task is terminal');
    }
    if (p.scope !== 'kernel' && !cleanup && (await requireSessionTx(tx, p.authority.rootPath)).status !== 'open') throw new ResourceCommandError('Resource owner is not open');
    let result: ResourceResult | undefined;
    if (c.type === 'create') {
        requireText(c.name);
        if (c.kind !== 'pool' && c.kind !== 'shared') throw new ResourceCommandError('Unsupported managed resource kind');
        if (c.kind === 'pool') positive(c.capacity!);
        if (c.physical) {
            if (c.kind !== 'pool') throw new ResourceCommandError('Only pool resources have physical bindings');
            requireText(c.physical.kind); requireText(c.physical.version); requireText(c.physical.externalId);
        }
        const resource: StoredResource = { ref: { id: createId('managed'), scope: p.scope }, kind: c.kind, name: c.name, version: 1, state: 'active',
            ...(c.authority ? { authorityId: c.authority.authorityId } : {}),
            ...(c.physical ? { physical: c.physical } : {}),
            ...(p.actor.taskId ? { creatorTaskId: p.actor.taskId } : {}),
            ...(c.kind === 'pool' ? { capacity: c.capacity } : { value: c.value ?? null }) };
        await tx.setEntry(path, key('resource', resource.ref.id), encode(resource)); result = resource;
    } else if (c.type === 'share' || c.type === 'revoke') {
        const r = await resourceTx(tx, p, c.ref);
        if (!isOwner(p, r)) throw new ResourceCommandError('Only the resource owner can share or revoke');
        if (c.type === 'share') activeResource(r);
        requireText(c.toSessionId);
        const previous = await grantTx(tx, path, r.ref.id, c.toSessionId);
        let next: ManagedGrant;
        if (c.type === 'share') {
            next = { ...previous, revision: previous.revision + 1, state: 'active',
                rights: [...new Set([...previous.rights, ...rights(c.rights)])] };
            result = { ok: true };
        } else {
            if (!Number.isSafeInteger(c.expectedRevision) || c.expectedRevision !== previous.revision) throw new ResourceCommandError('Resource grant revision conflict');
            const removed = c.rights === undefined ? previous.rights : rights(c.rights);
            const remaining = previous.rights.filter(right => !removed.includes(right));
            const epochs = { ...previous.epochs };
            for (const right of removed) epochs[right] = (epochs[right] ?? 0) + 1;
            next = { ...previous, revision: previous.revision + 1, rights: remaining, epochs, state: remaining.length ? 'active' : 'revoked' };
            result = next;
            if (removed.includes('execute')) {
                for (const claim of await claimsTx(tx, path, r.ref.id)) {
                    if (claim.sessionId === c.toSessionId && !(r.ref.scope === `session:${claim.sessionId}` && r.creatorTaskId === claim.taskId)) await beginReleaseTx(tx, path, r, claim);
                }
            }
        }
        await tx.setEntry(path, accessKey(r.ref.id, c.toSessionId), encode(next));
    } else if (c.type === 'destroy') {
        const r = await resourceTx(tx, p, c.ref);
        if (!isOwner(p, r)) throw new ResourceCommandError('Only the resource owner can destroy');
        if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion !== r.version) throw new ResourceCommandError('Resource version conflict');
        if (r.state === 'tombstoned') result = r;
        else {
            if (r.state !== 'closing') await tx.setEntry(path, key('resource', r.ref.id), encode({ ...r, state: 'closing', version: r.version + 1 }));
            for (const claim of await claimsTx(tx, path, r.ref.id)) await beginReleaseTx(tx, path, r, claim);
        }
    } else if (c.type === 'open') {
        const taskId = c.taskId ?? p.actor.taskId;
        if (!p.actorRoot || !p.actor.sessionId || !taskId || (p.actor.taskId && p.actor.taskId !== taskId)) throw new ResourceCommandError('Resource task binding mismatch');
        const task = await requireTaskTx(tx, p.actorRoot, taskId);
        if (isTerminal(task.status)) throw new ResourceCommandError('Resource task is terminal');
        requireText(c.name);
        const r = await resourceTx(tx, p, c.ref); activeResource(r);
        const requested = rights(c.rights), permitted = await allowed(tx, p, r);
        if (requested.some(v => !permitted.includes(v))) throw new ResourceCommandError('Resource grant denied');
        const localPath = resourcesPath(p.actorRoot);
        const existing = await rows<ManagedHandle>(tx, localPath, 'handle');
        if (existing.some(h => h.taskId === taskId && h.name === c.name && !h.closed)) throw new ResourceCommandError('Resource binding name already open');
        const handle: ManagedHandle = { id: createId('binding'), ref: r.ref, sessionId: p.actor.sessionId, taskId,
            rights: requested, name: c.name, closed: false,
            grantEpochs: isOwner(p, r) ? undefined : (await grantTx(tx, path, r.ref.id, p.actor.sessionId)).epochs };
        await tx.setEntry(localPath, key('handle', handle.id), encode(handle)); result = handle;
    } else if (c.type === 'release') {
        const claim = await read<ResourceClaim>(tx, path, key('claim', c.claim.id));
        if (!claim || claim.ref.scope !== p.scope || claim.ref.id !== c.claim.ref.id || claim.token !== c.claim.token
            || claim.sessionId !== p.actor.sessionId || (p.actor.taskId && claim.taskId !== p.actor.taskId)) throw new ResourceCommandError('Resource claim token/holder mismatch');
        const resource = await resourceTx(tx, p, claim.ref);
        const next = await beginReleaseTx(tx, path, resource, claim);
        if (next.released) result = next;
    } else {
        const { h, r } = await handleTx(tx, p, c.handle, c.type === 'acquire' ? 'execute' : c.type === 'read' ? 'read' : c.type === 'write' ? 'write' : undefined);
        if (c.type !== 'close' && isTerminal((await requireTaskTx(tx, p.actorRoot!, h.taskId)).status)) throw new ResourceCommandError('Resource task is terminal');
        if (c.type === 'close') {
            if ((await claimsTx(tx, path, r.ref.id)).some(claim => claim.handleId === h.id)) throw new ResourceCommandError('Resource binding has active claims; release after cleanup');
            result = { ...h, closed: true }; await tx.setEntry(resourcesPath(p.actorRoot!), key('handle', h.id), encode(result));
        } else if (c.type === 'read') result = r;
        else if (c.type === 'write') {
            if (r.kind !== 'shared' || !Number.isSafeInteger(c.expectedVersion) || c.expectedVersion !== r.version) throw new ResourceCommandError('Resource version conflict');
            result = { ...r, value: c.value, version: r.version + 1 };
            await tx.setEntry(path, key('resource', r.ref.id), encode(result));
        } else {
            positive(c.quantity);
            if (r.kind !== 'pool' || c.quantity > r.capacity!) throw new ResourceCommandError('Resource capacity exceeded');
            if (c.deadlineAt !== undefined && !Number.isFinite(c.deadlineAt)) throw new ResourceCommandError('Invalid resource deadline');
        }
    }
    const row: RequestRow = { id: c.requestId, scope: p.scope, actor: p.actor, actorRoot: p.actorRoot,
        fingerprint: fingerprint(c), command: c, sequence: await tx.increment(path, 'managed/sequence'),
        status: result === undefined ? 'pending' : 'succeeded', ...(result === undefined ? {} : { result }) };
    await finishTx(tx, p, row);
    if (p.actorRoot) await appendEventTx(tx, p.actorRoot, p.actor.sessionId!, p.actor.taskId, 'resource.requested', { requestId: row.id, scope: p.scope, operation: c.type });
    await sweepResourceTx(tx, p.authority);
    return (await read<RequestRow>(tx, path, requestKey(p.actor, c.requestId)))!;
}

export async function sweepResourceTx(tx: ISeqFileTransaction, authority: ResolvedStorageBinding) {
    const path = resourcesPath(authority.rootPath), blocked = new Set<string>();
    await schemaTx(tx, path, true);
    const requests = await settleLifecycleTx(tx, authority);
    const pending = requests.filter(r => r.status === 'pending').sort((a, b) => a.sequence - b.sequence);
    for (const row of pending) {
        if (row.command?.type !== 'acquire') continue;
        const c = row.command, p: PreparedResourceCommand = { authority, scope: row.scope, actor: row.actor, actorRoot: row.actorRoot, command: c };
        try {
            if (c.deadlineAt !== undefined && Date.now() >= c.deadlineAt) throw new ResourceCommandError('Resource request deadline exceeded');
            const session = await requireSessionTx(tx, row.actorRoot!);
            if (session.status === 'closing' || session.status === 'closed' || session.status === 'archived') throw new ResourceCommandError('Resource requester session is closing');
            const { h, r } = await handleTx(tx, p, c.handle, 'execute');
            const task = await readTaskTx(tx, row.actorRoot!, h.taskId);
            if (!task || isTerminal(task.status)) throw new ResourceCommandError('Resource requester task is missing or terminal');
            if (row.scope !== 'kernel') {
                const owner = await requireSessionTx(tx, authority.rootPath);
                if (owner.status === 'closing' || owner.status === 'closed' || owner.status === 'archived') throw new ResourceCommandError('Resource owner is closing');
                if (owner.status !== 'open') continue;
            }
            if (session.status !== 'open') continue;
            if (task.controlHolds?.length || task.sessionPaused || (task.control && task.control.mode !== 'run')) continue;
            if (blocked.has(r.ref.id)) continue;
            const held = (await claimsTx(tx, path, r.ref.id)).reduce((n, v) => n + v.quantity, 0);
            if (held + c.quantity > r.capacity!) { blocked.add(r.ref.id); continue; }
            const claim: ResourceClaim = { id: createId('claim'), ref: r.ref, handleId: h.id, sessionId: h.sessionId, taskId: h.taskId,
                quantity: c.quantity, token: createId('token'), released: false, state: 'held', epoch: 1 };
            await tx.setEntry(path, key('claim', claim.id), encode(claim)); row.status = 'succeeded'; row.result = claim;
        } catch (error) {
            if (!(error instanceof ResourceCommandError)) throw error;
            row.status = 'failed'; row.error = error.message;
        }
        await finishTx(tx, p, row);
        if (row.actorRoot) await appendEventTx(tx, row.actorRoot, row.actor.sessionId!, row.actor.taskId, 'resource.resolved', { requestId: row.id, scope: row.scope, status: row.status });
    }
    return requests;
}

function resourceDeadline(requests: RequestRow[], cleanups: ResourceCleanup[]): number | undefined {
    let next = Infinity;
    for (const row of requests) {
        if (row.status === 'pending' && row.command?.type === 'acquire') next = Math.min(next, row.command.deadlineAt ?? Infinity);
    }
    for (const row of cleanups) if (row.status !== 'succeeded') next = Math.min(next, row.nextAttemptAt);
    return Number.isFinite(next) ? next : undefined;
}

export class ManagedResourceStore {
    private readonly adapters = new Map<string, ManagedResourceAdapter>();
    private readonly processing = new Map<string, Promise<void>>();
    private readonly controllers = new Set<AbortController>();
    private disposed = false;
    get isIdle() { return this.processing.size === 0; }
    constructor(private readonly shared: ResolvedStorageBinding,
        private readonly resolveSession: (id: string) => Promise<ResolvedStorageBinding>,
        private readonly sessionIds: () => Promise<string[]> = async () => [],
        private readonly inspectSession: (id: string) => Promise<ResolvedStorageBinding> = resolveSession) {}
    registerAdapter(adapter: ManagedResourceAdapter) {
        requireText(adapter.kind); requireText(adapter.version);
        if (adapter.timeoutMs !== undefined && (!Number.isSafeInteger(adapter.timeoutMs) || adapter.timeoutMs < 1 || adapter.timeoutMs > 60_000))
            throw new ResourceCommandError('Resource adapter timeout must be 1..60000ms');
        this.adapters.set(JSON.stringify([adapter.kind, adapter.version]), adapter);
    }
    dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort(new Error('Resource worker disposed'));
    }
    async initialize() {
        await ensureSeqFile(this.shared.fs, resourcesPath(this.shared.rootPath));
        await transaction(this.shared.fs, tx => schemaTx(tx, resourcesPath(this.shared.rootPath), true));
    }
    private async binding(scope: string, inspect = false) {
        if (scope === 'kernel') return this.shared;
        if (!scope.startsWith('session:') || scope.length === 8) throw new ResourceCommandError('Invalid resource scope');
        return (inspect ? this.inspectSession : this.resolveSession)(scope.slice(8));
    }
    async prepare(actor: ResourceActor, command: ResourceCommand): Promise<PreparedResourceCommand> {
        const ref = 'ref' in command ? command.ref : 'handle' in command ? command.handle.ref : 'claim' in command ? command.claim.ref : undefined;
        const scope = ref?.scope ?? resourceScope(actor), authority = await this.binding(scope);
        const local = actor.sessionId ? await this.resolveSession(actor.sessionId) : undefined;
        if (local && local.fs !== authority.fs) throw new ResourceCommandError('Cross-backend resources require a broker; unsupported');
        return { authority, actorRoot: local?.rootPath, actor: { ...actor }, scope, command: structuredClone(command) };
    }
    async execute(actor: ResourceActor, command: ResourceCommand) {
        const p = await this.prepare(actor, command);
        return transaction(p.authority.fs, tx => executeResourceTx(tx, p));
    }
    async poll(actor: ResourceActor, scope: string, id: string, cancel = false): Promise<ResourceRequestSnapshot> {
        const authority = await this.binding(scope), local = actor.sessionId ? await this.resolveSession(actor.sessionId) : undefined;
        if (local && local.fs !== authority.fs) throw new ResourceCommandError('Cross-backend resources require a broker; unsupported');
        const snapshot = await transaction(authority.fs, async tx => {
            const path = resourcesPath(authority.rootPath);
            await schemaTx(tx, path, cancel);
            let row = await read<RequestRow>(tx, path, requestKey(actor, id));
            if (!row && !cancel) throw new ResourceCommandError('Resource request not found');
            if (cancel && row?.status === 'pending' && (row.command?.type === 'release' || row.command?.type === 'destroy'))
                throw new ResourceCommandError('Cleanup/destroy already accepted; cannot cancel');
            if (cancel && (!row || row.status === 'pending')) {
                requireText(id);
                row = { ...row, id, scope, actor, actorRoot: local?.rootPath, status: 'cancelled', sequence: row?.sequence ?? 0 };
                await finishTx(tx, { authority, actor, actorRoot: local?.rootPath, scope, command: { type: 'create', requestId: id, kind: 'shared', name: '_' } }, row);
            }
            await sweepResourceTx(tx, authority);
            const current = (await read<RequestRow>(tx, path, requestKey(actor, id)))!;
            return { id: current.id, scope, status: current.status, ...(current.result !== undefined ? { result: current.result } : {}), ...(current.error ? { error: current.error } : {}) };
        });
        // Only accepted requests can drive external work, always outside the transaction.
        if (snapshot.status === 'pending' && !cancel) await this.sweep(scope);
        return transaction(authority.fs, async tx => {
            const row = (await read<RequestRow>(tx, resourcesPath(authority.rootPath), requestKey(actor, id)))!;
            return { id: row.id, scope, status: row.status,
                ...(row.result !== undefined ? { result: row.result } : {}), ...(row.error ? { error: row.error } : {}) };
        });
    }
    async recover(scope: string, takeover = false) {
        const binding = await this.binding(scope, true);
        await transaction(binding.fs, async tx => {
            const path = resourcesPath(binding.rootPath);
            await schemaTx(tx, path, true);
            if (takeover) for (const operation of await rows<ResourceCleanup>(tx, path, 'cleanup')) {
                if (operation.status !== 'succeeded') await tx.setEntry(path, key('cleanup', operation.id),
                    encode({ ...operation, attempts: operation.attempts + 1, nextAttemptAt: Date.now() }));
            }
            await sweepResourceTx(tx, binding);
        });
    }
    async nextDeadline(scope: string): Promise<number | undefined> {
        const b = await this.binding(scope);
        return transaction(b.fs, async tx => {
            return resourceDeadline(await rows<RequestRow>(tx, resourcesPath(b.rootPath), 'request'),
                await rows<ResourceCleanup>(tx, resourcesPath(b.rootPath), 'cleanup'));
        });
    }
    async sweep(scope: string): Promise<number | undefined> {
        const b = await this.binding(scope);
        const snapshot = await transaction(b.fs, async tx => {
            const requests = await sweepResourceTx(tx, b);
            const cleanups = await rows<ResourceCleanup>(tx, resourcesPath(b.rootPath), 'cleanup');
            return { cleanups, deadline: resourceDeadline(requests, cleanups) };
        });
        if (this.disposed) return;
        const running = this.processing.get(scope);
        if (running) { await running; return this.nextDeadline(scope); }
        if (!snapshot.cleanups.some(row => row.status !== 'succeeded' && row.nextAttemptAt <= Date.now())) return snapshot.deadline;
        const operation = this.runCleanups(b, snapshot.cleanups).finally(() => this.processing.delete(scope));
        this.processing.set(scope, operation);
        await operation;
        return this.disposed ? undefined : this.nextDeadline(scope);
    }
    private async runCleanups(binding: ResolvedStorageBinding, due: ResourceCleanup[]) {
        const path = resourcesPath(binding.rootPath);
        for (const snapshot of due) {
            if (this.disposed) return;
            if (snapshot.status === 'succeeded' || snapshot.nextAttemptAt > Date.now()) continue;
            const adapter = this.adapters.get(JSON.stringify([snapshot.physical.kind, snapshot.physical.version]));
            const timeout = adapter?.timeoutMs ?? 1000;
            const pending = await transaction(binding.fs, async tx => {
                const current = await read<ResourceCleanup>(tx, path, key('cleanup', snapshot.id));
                if (!current || current.status === 'succeeded' || current.nextAttemptAt > Date.now()) return;
                const next = { ...current, attempts: current.attempts + 1, nextAttemptAt: Date.now() + timeout };
                await tx.setEntry(path, key('cleanup', next.id), encode(next));
                const claim = next.claimId ? await read<ResourceClaim>(tx, path, key('claim', next.claimId)) : undefined;
                return { next, claim };
            });
            if (!pending) continue;
            if (this.disposed) return;
            const { next, claim } = pending, controller = new AbortController();
            this.controllers.add(controller);
            let timer: ReturnType<typeof setTimeout> | undefined;
            let receipt: ResourceCleanupReceipt;
            try {
                if (!adapter) throw new Error('Resource cleanup adapter unavailable');
                const context = { operationId: next.id, epoch: next.epoch, resource: next.ref,
                    physical: next.physical, claim, signal: controller.signal };
                const interrupted = new Promise<never>((_, reject) => {
                    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
                    timer = setTimeout(() => controller.abort(new Error('Resource cleanup timed out')), timeout);
                });
                receipt = await Promise.race([
                    Promise.resolve().then(() => next.claimId ? adapter.cleanup(context) : adapter.destroy(context)),
                    interrupted,
                ]);
                assertDurableValue(receipt, 'Resource cleanup receipt');
                if (receipt.operationId !== next.id || receipt.epoch !== next.epoch
                    || !['stopped', 'pending', 'unknown'].includes(receipt.status))
                    throw new Error('Resource cleanup receipt identity/status mismatch');
                if (receipt.retryAfterMs !== undefined && (!Number.isFinite(receipt.retryAfterMs) || receipt.retryAfterMs < 0))
                    throw new Error('Invalid cleanup retry delay');
            } catch (error) {
                receipt = { operationId: next.id, epoch: next.epoch, status: 'unknown', error: error instanceof Error ? error.message : String(error) };
            } finally {
                if (timer) clearTimeout(timer);
                this.controllers.delete(controller);
            }
            if (this.disposed) return; // durable intent is reconciled by the replacement
            await transaction(binding.fs, async tx => {
                const current = await read<ResourceCleanup>(tx, path, key('cleanup', next.id));
                if (!current || current.status === 'succeeded' || current.epoch !== next.epoch || current.attempts !== next.attempts) return;
                const stopped = receipt.status === 'stopped';
                await tx.setEntry(path, key('cleanup', next.id), encode({ ...current,
                    status: stopped ? 'succeeded' : receipt.status, receipt,
                    error: receipt.error, nextAttemptAt: Date.now() + Math.max(25, Math.min(60_000, receipt.retryAfterMs ?? 1000)) }));
                if (stopped && next.claimId) {
                    const held = await read<ResourceClaim>(tx, path, key('claim', next.claimId));
                    if (!held || held.cleanupId !== next.id || held.epoch !== next.epoch) throw new ResourceCommandError('Cleanup claim fence mismatch');
                    await tx.setEntry(path, key('claim', held.id), encode({ ...held, state: 'released', released: true }));
                }
                await sweepResourceTx(tx, binding);
            });
        }
    }
    async list(actor: ResourceActor) {
        if (!actor.sessionId) return [];
        const b = await this.resolveSession(actor.sessionId);
        return transaction(b.fs, async tx => {
            await schemaTx(tx, resourcesPath(b.rootPath));
            return (await rows<ManagedHandle>(tx, resourcesPath(b.rootPath), 'handle')).filter(h => !actor.taskId || h.taskId === actor.taskId);
        });
    }
    async stat(actor: ResourceActor, ref: ManagedResourceRef) {
        const p = await this.prepare(actor, { type: 'share', requestId: '_stat', ref, toSessionId: '_', rights: ['read'] });
        return transaction(p.authority.fs, async tx => {
            await schemaTx(tx, resourcesPath(p.authority.rootPath));
            const r = await resourceTx(tx, p, ref);
            const permitted = await allowed(tx, p, r);
            if (!permitted.length) throw new ResourceCommandError('Resource grant denied');
            const visible = { ...r };
            if (!permitted.includes('read')) delete visible.value;
            const path = resourcesPath(p.authority.rootPath);
            return { resource: visible, held: (await claimsTx(tx, path, r.ref.id)).reduce((n, c) => n + c.quantity, 0),
                waiting: (await rows<RequestRow>(tx, path, 'request')).filter(q => q.status === 'pending' && q.command?.type === 'acquire' && q.command.handle.ref.id === r.ref.id).length };
        });
    }
    async claimAuthority(actor: ResourceActor, authorityId: string, claim: AuthorityClaim = {}): Promise<ManagedAuthority> {
        claim = structuredClone(claim);
        const scope = claim.scope ?? resourceScope(actor);
        if (actor.sessionId && scope !== resourceScope(actor)) throw new ResourceCommandError('Authority scope denied');
        const b = await this.binding(scope);
        const local = actor.sessionId ? await this.resolveSession(actor.sessionId) : undefined;
        if (local && local.fs !== b.fs) throw new ResourceCommandError('Cross-backend resources require a broker; unsupported');
        const path = resourcesPath(b.rootPath);
        return transaction(b.fs, async tx => {
            await schemaTx(tx, path, true);
            return claimAuthorityTx(tx, path, authorityId, claim);
        });
    }
    async authority(actor: ResourceActor, authorityId: string, scope?: string): Promise<ManagedAuthority | undefined> {
        const b = await this.binding(scope ?? resourceScope(actor));
        const local = actor.sessionId ? await this.resolveSession(actor.sessionId) : undefined;
        if (local && local.fs !== b.fs) throw new ResourceCommandError('Cross-backend resources require a broker; unsupported');
        const path = resourcesPath(b.rootPath);
        return transaction(b.fs, async tx => {
            await schemaTx(tx, path);
            return read<ManagedAuthority>(tx, path, authorityKey(authorityId));
        });
    }
    async query(actor: ResourceActor, options: ResourceQuery): Promise<ResourcePage> {
        const kinds = { resources: 'resource', claims: 'claim', requests: 'request', grants: 'access', cleanups: 'cleanup' } as const;
        if (!Object.hasOwn(kinds, options.kind)) throw new ResourceCommandError('Invalid resource query kind');
        const limit = options.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ResourceCommandError('Resource query limit must be 1..200');
        const filter = fingerprint({ ...options, cursor: undefined, limit: undefined, actor });
        let after = '';
        if (options.cursor) {
            try {
                const cursor = JSON.parse(options.cursor);
                if (cursor.filter !== filter || typeof cursor.after !== 'string') throw new Error();
                after = cursor.after;
            } catch { throw new ResourceCommandError('Resource cursor does not match query'); }
        }
        const scopes = options.scope ? [options.scope]
            : [...new Set(['kernel', ...(await this.sessionIds()).map(id => `session:${id}`),
                ...(actor.sessionId ? [resourceScope(actor)] : [])])];
        const found: Array<{ key: string; value: ResourcePage['items'][number] }> = [];
        for (const scope of [...new Set(scopes)].sort()) {
            const b = await this.binding(scope, true);
            const local = actor.sessionId ? await this.inspectSession(actor.sessionId) : undefined;
            if (local && local.fs !== b.fs) {
                if (options.scope) throw new ResourceCommandError('Cross-backend resource query unsupported');
                continue;
            }
            await transaction(b.fs, async tx => {
                const path = resourcesPath(b.rootPath);
                await schemaTx(tx, path);
                const p: PreparedResourceCommand = { authority: b, actor, actorRoot: local?.rootPath, scope,
                    command: { type: 'create', requestId: '_query', kind: 'shared', name: '_' } };
                await tx.walkEntries(path, async entry => {
                    const row = decode<any>(entry.value);
                    // Legacy arrays are normalized for management queries without mutating storage.
                    let value: ResourcePage['items'][number] = row;
                    let resourceId: string | undefined;
                    if (options.kind === 'grants') {
                        const [id, sessionId] = JSON.parse(decodeURIComponent(entry.key.slice('managed/access/'.length)));
                        value = await grantTx(tx, path, id, sessionId); resourceId = id;
                    } else if (options.kind === 'requests') {
                        resourceId = row.command?.ref?.id ?? row.command?.handle?.ref?.id ?? row.command?.claim?.ref?.id ?? row.result?.ref?.id;
                        value = { id: row.id, scope, sessionId: row.actor.sessionId, taskId: row.actor.taskId,
                            operation: row.command?.type, status: row.status, error: row.error } satisfies ResourceRequestInfo;
                    } else {
                        resourceId = row.ref?.id;
                        if (options.kind === 'resources') value = { ...row, state: row.state ?? 'active' };
                        if (options.kind === 'claims') value = { ...row, state: row.state ?? (row.released ? 'released' : 'held') };
                    }
                    const resource = resourceId ? await read<StoredResource>(tx, path, key('resource', resourceId)) : undefined;
                    const owner = resource && isOwner(p, resource);
                    const recordActor = options.kind === 'resources' ? { sessionId: scope.startsWith('session:') ? scope.slice(8) : undefined, taskId: row.creatorTaskId }
                        : options.kind === 'requests' ? row.actor : options.kind === 'cleanups'
                        ? (row.claimId ? await read<ResourceClaim>(tx, path, key('claim', row.claimId)) : undefined) : value;
                    if (actor.sessionId) {
                        if (options.kind === 'resources') {
                            if (!resource || !(await allowed(tx, p, resource)).length) return true;
                            value = { ...resource, state: resource.state ?? 'active' };
                            if (!(await allowed(tx, p, resource)).includes('read')) delete (value as ManagedResource).value;
                        } else if (options.kind === 'grants') {
                            if (!owner) return true;
                        } else if (!owner && (recordActor?.sessionId !== actor.sessionId || (actor.taskId && recordActor?.taskId !== actor.taskId))) return true;
                    }
                    if (options.sessionId && recordActor?.sessionId !== options.sessionId) return true;
                    if (options.taskId && recordActor?.taskId !== options.taskId) return true;
                    const state = 'state' in value ? value.state : 'status' in value ? value.status : undefined;
                    if (options.state && state !== options.state) return true;
                    const position = JSON.stringify([scope, entry.key]);
                    if (position > after) found.push({ key: position, value });
                    return true;
                }, { keyPrefix: `managed/${kinds[options.kind]}/` });
            });
        }
        found.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        const page = found.slice(0, limit);
        return { items: page.map(row => row.value), ...(found.length > limit
            ? { nextCursor: JSON.stringify({ filter, after: page[page.length - 1].key }) } : {}) };
    }

    async canClose(sessionId: string): Promise<boolean> {
        const actor = { sessionId }, scopes = new Set(['kernel', resourceScope(actor), ...(await this.list(actor)).map(h => h.ref.scope)]);
        for (const scope of scopes) {
            const b = await this.binding(scope);
            if (await transaction(b.fs, async tx => (await rows<ResourceClaim>(tx, resourcesPath(b.rootPath), 'claim')).some(c => !c.released && (c.sessionId === sessionId || scope === resourceScope(actor))))) return false;
        }
        return true;
    }
    async validate(actor: ResourceActor, claim: ResourceClaim): Promise<ResourceClaim> {
        const p = await this.prepare(actor, { type: 'release', requestId: '_validate', claim });
        return transaction(p.authority.fs, async tx => {
            const current = await read<ResourceClaim>(tx, resourcesPath(p.authority.rootPath), key('claim', claim.id));
            if (!current || current.released || current.state === 'cleanup-pending' || current.token !== claim.token || current.ref.id !== claim.ref.id
                || current.sessionId !== actor.sessionId || (actor.taskId && current.taskId !== actor.taskId)) throw new ResourceCommandError('Resource claim is not active for this holder');
            const handle = await read<ManagedHandle>(tx, resourcesPath(p.actorRoot!), key('handle', current.handleId));
            if (!handle) throw new ResourceCommandError('Resource handle missing');
            await handleTx(tx, p, handle, 'execute');
            if (p.scope !== 'kernel' && (await requireSessionTx(tx, p.authority.rootPath)).status !== 'open') throw new ResourceCommandError('Resource owner is not open');
            const local = await requireSessionTx(tx, p.actorRoot!);
            const task = await requireTaskTx(tx, p.actorRoot!, current.taskId);
            if (local.status !== 'open' || isTerminal(task.status) || task.controlHolds?.length || task.sessionPaused || (task.control && task.control.mode !== 'run')) throw new ResourceCommandError('Resource holder is not running');
            return current;
        });
    }
}

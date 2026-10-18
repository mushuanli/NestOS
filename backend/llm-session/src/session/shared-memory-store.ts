import { ulid } from '../persistence/ulid';
import { sha256HexSync } from '@itookit/llm-context';
import { type MemoryPolicy } from '@itookit/llm-tasks/contracts';
import { FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';

type Reference = NonNullable<MemoryPolicy['sharedMemory']>;
import type { MemoryOrigin, SharedMemoryGrant, SharedMemoryResource, SharedMemoryAudit } from '../contracts/memory';
export type { MemoryOrigin, SharedMemoryGrant, SharedMemoryResource, SharedMemoryAudit } from '../contracts/memory';

const FILE = '/var/lib/memory/shared.seq';

/** One local transaction authority; never exposed through a Session file mount. */
export class SharedMemoryStore {
    constructor(private readonly fs: IFileSystem) {}

    async init(): Promise<void> {
        if (!this.fs.meta.seq?.transaction) throw new Error('Shared Memory requires record transactions');
        if (await this.fs.driver.exists(FILE)) return;
        try { await this.fs.driver.createFile({ parentPath: '/var/lib/memory', name: 'shared.seq', type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }

    /** Host-only administration. Creation does not infer any reader or writer grant. */
    async create(id: string, namespaceId: string, creatorSessionId: string): Promise<SharedMemoryResource> {
        requireIdentity(id); requireIdentity(namespaceId); requireIdentity(creatorSessionId);
        return this.transaction(async tx => {
            const old = await tx.getEntry(FILE, resourceKey(id));
            if (old && !parseResource(old).deleted) throw new Error('Shared Memory resource already exists');
            const resource: SharedMemoryResource = { id, incarnation: ulid(), namespaceId,
                creatorSessionId, revision: 1, deleted: false, grants: {} };
            await tx.setEntry(FILE, resourceKey(id), JSON.stringify(resource));
            await audit(tx, resource, { action: 'create', sessionId: creatorSessionId });
            return structuredClone(resource);
        });
    }

    /** Passing null revokes all access for that exact Session. */
    async grant(ref: Reference, sessionId: string, grant: SharedMemoryGrant | null, expectedRevision: number): Promise<void> {
        requireIdentity(sessionId);
        if (grant) for (const scopes of [grant.readScopes, grant.writeScopes]) {
            if (!Array.isArray(scopes)) throw new Error('Invalid shared Memory scopes');
            scopes.forEach(requireIdentity);
        }
        await this.adminUpdate(ref, expectedRevision, resource => {
            if (grant) Object.defineProperty(resource.grants, sessionId, { value: structuredClone(grant), enumerable: true, writable: true, configurable: true });
            else delete resource.grants[sessionId];
        }, { action: grant ? 'grant' : 'revoke', sessionId });
    }

    async remove(ref: Reference, expectedRevision: number): Promise<void> {
        await this.adminUpdate(ref, expectedRevision, resource => { resource.deleted = true; resource.grants = {}; },
            { action: 'delete', sessionId: 'host' });
    }

    async inspect(ref: Reference): Promise<SharedMemoryResource> {
        return this.transaction(tx => this.resource(tx, ref));
    }

    async list(): Promise<SharedMemoryResource[]> {
        return this.transaction(async tx => {
            const resources: SharedMemoryResource[] = [];
            await tx.walkEntries(FILE, entry => { const item = parseResource(entry.value); if (!item.deleted) resources.push(item); return true; }, { keyPrefix: 'resource/' });
            return resources;
        });
    }

    async history(ref: Reference, limit = 100): Promise<SharedMemoryAudit[]> {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid Memory audit limit');
        return this.transaction(async tx => {
            const result: SharedMemoryAudit[] = [];
            await tx.walkEntries(FILE, entry => { result.push(JSON.parse(entry.value)); return true; }, { keyPrefix: auditPrefix(ref), limit });
            return result;
        });
    }

    async read(sessionId: string, policy: MemoryPolicy, scope: string): Promise<unknown> {
        return this.transaction(async tx => {
            const resource = await this.authorize(tx, sessionId, policy, scope, 'readScopes');
            const record = await tx.getEntry(FILE, dataKey(resource, scope));
            return record ? JSON.parse(record).entries : undefined;
        });
    }

    async mutate(sessionId: string, policy: MemoryPolicy, scope: string, origin: MemoryOrigin, payload: unknown,
        change: (value: unknown) => { entries: unknown; result: number }, requireRead = false): Promise<number> {
        policy = structuredClone(policy); origin = structuredClone(origin); payload = structuredClone(payload);
        requireIdentity(origin.operationId);
        const digest = sha256HexSync(JSON.stringify([policy, payload]));
        return this.transaction(async tx => {
            const resource = await this.authorize(tx, sessionId, policy, scope, 'writeScopes');
            if (requireRead) await this.authorize(tx, sessionId, policy, scope, 'readScopes');
            const receiptKey = `receipt/${JSON.stringify([resource.id, resource.incarnation, sessionId, origin.operationId])}`;
            const receipt = await tx.getEntry(FILE, receiptKey);
            if (receipt) {
                const saved = JSON.parse(receipt);
                if (saved.digest !== digest || saved.scope !== scope) throw new Error('Memory operation identity conflict');
                return saved.result;
            }
            const key = dataKey(resource, scope);
            const raw = await tx.getEntry(FILE, key);
            const previous = raw ? JSON.parse(raw) : { version: 0 };
            if (!Number.isSafeInteger(previous.version) || previous.version >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid Memory data version');
            const next = change(previous.entries);
            await tx.setEntry(FILE, key, JSON.stringify({ entries: next.entries, version: previous.version + 1 }));
            await tx.setEntry(FILE, receiptKey, JSON.stringify({ digest, scope, result: next.result }));
            await audit(tx, resource, { action: 'mutate', sessionId, scope, origin, dataVersion: previous.version + 1 });
            return next.result;
        });
    }

    private async adminUpdate(ref: Reference, expected: number, change: (resource: SharedMemoryResource) => void,
        event: Pick<SharedMemoryAudit, 'action' | 'sessionId'>): Promise<void> {
        await this.transaction(async tx => {
            const resource = await this.resource(tx, ref);
            if (resource.revision !== expected || resource.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Shared Memory resource changed');
            change(resource); resource.revision++;
            await tx.setEntry(FILE, resourceKey(ref.id), JSON.stringify(resource));
            await audit(tx, resource, event);
        });
    }

    private async authorize(tx: ISeqFileTransaction, sessionId: string, policy: MemoryPolicy, scope: string,
        permission: keyof SharedMemoryGrant): Promise<SharedMemoryResource> {
        if (!policy.sharedMemory) throw new Error('Shared Memory reference is required');
        const resource = await this.resource(tx, policy.sharedMemory);
        const grant = Object.hasOwn(resource.grants, sessionId) ? resource.grants[sessionId] : undefined;
        if (resource.namespaceId !== policy.namespaceId || !grant?.[permission].includes(scope)
            || !policy[permission].includes(scope)) throw new Error(`Shared Memory ${permission} denied: ${scope}`);
        return resource;
    }

    private async resource(tx: ISeqFileTransaction, ref: Reference): Promise<SharedMemoryResource> {
        requireIdentity(ref.id); requireIdentity(ref.incarnation);
        const raw = await tx.getEntry(FILE, resourceKey(ref.id));
        const resource = raw ? parseResource(raw) : undefined;
        if (!resource || resource.id !== ref.id || resource.deleted || resource.incarnation !== ref.incarnation) throw new Error('Shared Memory resource is unavailable');
        return resource;
    }

    private transaction<T>(action: (tx: ISeqFileTransaction) => Promise<T>): Promise<T> {
        if (!this.fs.meta.seq?.transaction) throw new Error('Shared Memory requires record transactions');
        return this.fs.meta.seq.transaction(action);
    }
}

function resourceKey(id: string): string { return `resource/${JSON.stringify(id)}`; }
function dataKey(ref: Reference, scope: string): string { return `entries/${JSON.stringify([ref.id, ref.incarnation, scope])}`; }
function auditPrefix(ref: Reference): string { return `audit/${JSON.stringify([ref.id, ref.incarnation])}/`; }
function requireIdentity(value: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid Memory identity'); }

function parseResource(raw: string): SharedMemoryResource {
    const value = JSON.parse(raw) as SharedMemoryResource;
    for (const id of [value.id, value.incarnation, value.namespaceId, value.creatorSessionId]) requireIdentity(id);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean'
        || !value.grants || typeof value.grants !== 'object' || Array.isArray(value.grants)) throw new Error('Invalid shared Memory resource');
    for (const grant of Object.values(value.grants)) for (const scopes of [grant?.readScopes, grant?.writeScopes]) {
        if (!Array.isArray(scopes)) throw new Error('Invalid shared Memory grant');
        scopes.forEach(requireIdentity);
    }
    return value;
}

async function audit(tx: ISeqFileTransaction, resource: SharedMemoryResource,
    event: Omit<SharedMemoryAudit, 'at' | 'resourceRevision'>): Promise<void> {
    await tx.append(FILE, auditPrefix(resource), JSON.stringify({ ...event, at: Date.now(), resourceRevision: resource.revision }));
}

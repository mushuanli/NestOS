import { ulid } from '../persistence/ulid';
import type { RetrievedMemoryEntry } from '@itookit/llm-context';
import { sha256Hex, type ContextPlan } from '@itookit/llm-context';
import { type MemoryPolicy } from '@itookit/llm-tasks/contracts';
import { KernelError, KernelErrorCode, type Kernel, type SessionHandle } from '@itookit/durable-kernel';
import { SharedMemoryStore, type MemoryOrigin } from './shared-memory-store';

import type { MemoryEntry, MemoryWrite, MemoryMutationOptions, MemoryCompressionSource } from '../contracts/memory';
export type { MemoryEntry, MemoryWrite, MemoryMutationOptions, MemoryCompressionSource } from '../contracts/memory';
type StoredMemory = MemoryEntry;

/** Session-local durable memory; all scopes are exact names, never implicit wildcard grants. */
export class SessionMemoryProvider {
    constructor(private readonly kernel: Kernel, readonly shared?: SharedMemoryStore) {}

    /** Enumerate readable entries for management, preserving the identity used by writes. */
    async list(sessionId: string, policy: MemoryPolicy): Promise<MemoryEntry[]> {
        policy = structuredClone(policy);
        validatePolicy(policy);
        if (!policy.readScopes.length) return [];
        if (policy.sharedMemory) {
            const groups = await Promise.all([...new Set(policy.readScopes)].map(async scope =>
                readEntries(await this.requireShared().read(sessionId, policy, scope), policy.namespaceId, scope)));
            return groups.flat().sort((a, b) => a.scope.localeCompare(b.scope) || a.entryId.localeCompare(b.entryId));
        }
        const session = await this.kernel.openSession(sessionId);
        const groups = await Promise.all([...new Set(policy.readScopes)].map(async scope =>
            readEntries((await session.getShared(memoryKey(policy.namespaceId, scope)))?.value, policy.namespaceId, scope)));
        return groups.flat().sort((a, b) => a.scope.localeCompare(b.scope) || a.entryId.localeCompare(b.entryId));
    }

    async upsert(sessionId: string, policy: MemoryPolicy, entry: MemoryWrite, options: MemoryMutationOptions = {}): Promise<void> {
        policy = structuredClone(policy); entry = structuredClone(entry); options = structuredClone(options);
        const expected = validateExpectedHash(options.expectedContentHash);
        const revision = validateExpectedRevision(options.expectedRevision);
        validatePolicy(policy);
        requireId(entry.entryId); requireId(entry.scope);
        if (typeof entry.content !== 'string') throw new Error('Memory content must be a string');
        if (!policy.writeScopes.includes(entry.scope)) throw new Error(`Memory write scope denied: ${entry.scope}`);
        const saved: StoredMemory = { entryId: entry.entryId, scope: entry.scope, content: entry.content, namespaceId: policy.namespaceId,
            contentHash: await hashContent(entry.content), updatedAt: Date.now(), revision: ulid(),
            source: { sessionId, ...(options.origin?.taskId ? { taskId: options.origin.taskId } : {}),
                ...(options.origin?.effectId ? { effectId: options.origin.effectId } : {}) } };
        await this.mutate(sessionId, policy, entry.scope,
            entries => {
                assertExpectedContent(entries, entry.entryId, expected);
                assertExpectedRevision(entries, entry.entryId, revision);
                return applyRetention([...entries.filter(item => item.entryId !== entry.entryId), saved], policy, saved.entryId);
            }, options.origin, { action: 'write', entry, expected, revision });
    }

    /**
     * Retention/GC for stored memory: drop entries of the policy's write scopes that were
     * last updated before `before` (host-owned watermark). Entries stay Session-local.
     */
    async prune(sessionId: string, policy: MemoryPolicy, before: number): Promise<{ removed: number }> {
        policy = structuredClone(policy);
        validatePolicy(policy);
        if (!Number.isFinite(before) || before < 0) throw new Error('Invalid memory retention watermark');
        let removed = 0;
        for (const scope of new Set(policy.writeScopes)) {
            removed += await this.mutate(sessionId, policy, scope,
                entries => entries.filter(entry => entry.updatedAt >= before), undefined, { action: 'prune', before });
        }
        return { removed };
    }

    async remove(sessionId: string, policy: MemoryPolicy, scope: string, entryId: string, options: MemoryMutationOptions = {}): Promise<void> {
        policy = structuredClone(policy); options = structuredClone(options);
        const expected = validateExpectedHash(options.expectedContentHash);
        const revision = validateExpectedRevision(options.expectedRevision);
        validatePolicy(policy); requireId(scope); requireId(entryId);
        if (!policy.writeScopes.includes(scope)) throw new Error(`Memory write scope denied: ${scope}`);
        await this.mutate(sessionId, policy, scope,
            entries => {
                assertExpectedContent(entries, entryId, expected);
                assertExpectedRevision(entries, entryId, revision);
                return entries.filter(item => item.entryId !== entryId);
            }, options.origin, { action: 'remove', entryId, expected, revision });
    }

    private requireShared(): SharedMemoryStore {
        if (!this.shared) throw new Error('Shared Memory is not configured in this host');
        return this.shared;
    }

    /** Commit a model-produced summary only while every source is still the captured version. */
    async compact(sessionId: string, policy: MemoryPolicy, entry: MemoryWrite, sources: MemoryCompressionSource[],
        options: MemoryMutationOptions & { model?: string } = {}): Promise<void> {
        policy = structuredClone(policy); entry = structuredClone(entry); sources = structuredClone(sources); options = structuredClone(options);
        const expected = validateExpectedHash(options.expectedContentHash);
        const revision = validateExpectedRevision(options.expectedRevision) ?? null;
        validatePolicy(policy); requireId(entry.entryId); requireId(entry.scope);
        if (!policy.readScopes.includes(entry.scope) || !policy.writeScopes.includes(entry.scope)) throw new Error('Memory compaction scope denied');
        if (typeof entry.content !== 'string' || !entry.content.trim() || !Array.isArray(sources) || !sources.length || sources.length > 100
            || new Set(sources.map(source => source.entryId)).size !== sources.length || sources.some(source => source.entryId === entry.entryId)) {
            throw new Error('Invalid Memory compaction sources or summary');
        }
        for (const source of sources) { requireId(source.entryId); requireId(source.revision); }
        const summary: StoredMemory = { ...entry, namespaceId: policy.namespaceId, revision: ulid(), updatedAt: Date.now(),
            contentHash: await hashContent(entry.content), source: { sessionId, ...(options.origin?.taskId ? { taskId: options.origin.taskId } : {}),
                ...(options.origin?.effectId ? { effectId: options.origin.effectId } : {}) } };
        await this.mutate(sessionId, policy, entry.scope, entries => {
            const original = sources.map(source => requireCompressionSource(entries, source));
            assertExpectedContent(entries, entry.entryId, expected);
            assertExpectedRevision(entries, entry.entryId, revision);
            if (new TextEncoder().encode(entry.content).byteLength >= original.reduce((sum, item) => sum + new TextEncoder().encode(item.content).byteLength, 0)) {
                throw new Error('Memory summary must be smaller than its sources');
            }
            const next = [...entries.filter(item => item.entryId !== entry.entryId), { ...summary, compression: { version: 1 as const,
                sources: original.map(item => ({ entryId: item.entryId, revision: item.revision, contentHash: item.contentHash })),
                ...(options.model ? { model: options.model } : {}) } }];
            if (policy.retention?.maxEntriesPerScope && next.length > policy.retention.maxEntriesPerScope) throw new Error('Memory capacity cannot retain the summary and its sources');
            return next;
        }, options.origin, { action: 'compact', entry, sources, expected, revision, model: options.model }, true);
    }

    private async mutate(sessionId: string, policy: MemoryPolicy, scope: string, change: (entries: StoredMemory[]) => StoredMemory[],
        origin: MemoryOrigin | undefined, payload: unknown, requireRead = false): Promise<number> {
        if (!policy.sharedMemory) return mutate(await this.kernel.openSession(sessionId), policy.namespaceId, scope, change);
        return this.requireShared().mutate(sessionId, policy, scope, origin ?? { operationId: ulid() }, payload, value => {
            const entries = readEntries(value, policy.namespaceId, scope);
            const next = change(entries);
            return { entries: next, result: entries.length - next.length };
        }, requireRead);
    }

    readonly retrieve = async (plan: ContextPlan, _agent: { id: string; version: string },
        context: { sessionId: string; policy?: MemoryPolicy }): Promise<RetrievedMemoryEntry[]> => {
        const policy = context.policy ? structuredClone(context.policy) : undefined;
        if (!policy) return [];
        validatePolicy(policy);
        const limit = policy.retrievalLimit ?? 10;
        if (!limit || !policy.readScopes.length) return [];
        const entries = await this.list(context.sessionId, policy);
        const pending = plan.pendingUserMessage?.content;
        const text = typeof pending === 'string' ? pending : '';
        const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
        const score = (entry: StoredMemory) => terms.filter(term => entry.content.toLowerCase().includes(term)).length;
        return entries.sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt
            || a.scope.localeCompare(b.scope) || a.entryId.localeCompare(b.entryId)).slice(0, limit)
            .map(({ scope, updatedAt, ...entry }) => ({ ...entry, entryId: JSON.stringify([scope, entry.entryId]) }));
    };
}

const memoryKey = (namespace: string, scope: string): string => `memory.entries.${JSON.stringify([namespace, scope])}`;

function validateExpectedHash(value: string | null | undefined): string | null | undefined {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
        throw new Error('Invalid expected memory content hash');
    }
    return value;
}

function assertExpectedContent(entries: StoredMemory[], entryId: string, expected: string | null | undefined): void {
    if (expected === undefined) return;
    if ((entries.find(entry => entry.entryId === entryId)?.contentHash ?? null) !== expected) {
        throw new Error('Memory content changed; reload before editing');
    }
}

function validateExpectedRevision(value: string | null | undefined): string | null | undefined {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.trim() || value.length > 256)) {
        throw new Error('Invalid expected memory revision');
    }
    return value;
}

function assertExpectedRevision(entries: StoredMemory[], entryId: string, expected: string | null | undefined): void {
    if (expected !== undefined && (entries.find(entry => entry.entryId === entryId)?.revision ?? null) !== expected) {
        throw new Error('Memory revision changed; compare the latest entry before retrying');
    }
}

async function mutate(session: SessionHandle, namespace: string, scope: string, change: (entries: StoredMemory[]) => StoredMemory[]): Promise<number> {
    const key = memoryKey(namespace, scope);
    for (let attempt = 0; attempt < 3; attempt++) {
        const previous = await session.getShared(key);
        const entries = readEntries(previous?.value, namespace, scope);
        const next = change(entries);
        if (JSON.stringify(entries) === JSON.stringify(next)) return 0;
        try {
            await session.setShared(key, next.map(entry => ({ ...entry })), { expectedVersion: previous?.version ?? null });
            return entries.length - next.length;
        }
        catch (error) {
            if (!(error instanceof KernelError) || error.code !== KernelErrorCode.CONFLICT || attempt === 2) throw error;
        }
    }
    throw new Error('Memory mutation retry limit reached');
}

function readEntries(value: unknown, namespace: string, scope: string): StoredMemory[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Invalid stored memory entries');
    const ids = new Set<string>();
    for (const item of value) {
        if (!item || typeof item !== 'object' || typeof item.entryId !== 'string' || !item.entryId.trim()
            || typeof item.content !== 'string' || typeof item.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentHash)
            || item.namespaceId !== namespace || item.scope !== scope || !Number.isSafeInteger(item.updatedAt)
            || (item.revision !== undefined && (typeof item.revision !== 'string' || !item.revision.trim() || item.revision.length > 256))
            || item.updatedAt < 0 || ids.has(item.entryId)) throw new Error('Invalid stored memory entry');
        ids.add(item.entryId);
    }
    return structuredClone(value).map((entry: StoredMemory) => ({ ...entry,
        revision: entry.revision ?? `legacy:${entry.contentHash}:${entry.updatedAt}` }));
}

function validatePolicy(policy: MemoryPolicy): void {
    requireId(policy.namespaceId);
    for (const scopes of [policy.readScopes, policy.writeScopes]) {
        if (!Array.isArray(scopes)) throw new Error('Invalid memory scopes');
        for (const scope of scopes) requireId(scope);
    }
    if (policy.retrievalLimit !== undefined && (!Number.isSafeInteger(policy.retrievalLimit) || policy.retrievalLimit < 0)) {
        throw new Error('Invalid memory retrieval limit');
    }
    const cap = policy.retention?.maxEntriesPerScope;
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) throw new Error('Invalid memory retention cap');
    const before = policy.retention?.before;
    if (before !== undefined && (!Number.isFinite(before) || before < 0)) throw new Error('Invalid memory retention watermark');
}

function requireCompressionSource(entries: StoredMemory[], source: MemoryCompressionSource): StoredMemory {
    const entry = entries.find(item => item.entryId === source.entryId);
    if (!entry || entry.revision !== source.revision) throw new Error('Memory compression source changed; read and summarize again');
    return entry;
}

/** Reserve capacity for this write, even if wall-clock timestamps tie or move backward. */
function applyRetention(entries: StoredMemory[], policy: MemoryPolicy, writtenId: string): StoredMemory[] {
    const cap = policy.retention?.maxEntriesPerScope;
    const before = policy.retention?.before;
    const retained = before === undefined ? entries : entries.filter(entry => entry.updatedAt >= before);
    if (cap === undefined || retained.length <= cap) return retained;
    return [...retained].sort((a, b) => Number(b.entryId === writtenId) - Number(a.entryId === writtenId)
        || b.updatedAt - a.updatedAt || a.entryId.localeCompare(b.entryId)).slice(0, cap);
}

function requireId(id: string): void {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Memory identity is required');
}

async function hashContent(content: string): Promise<string> {
    return sha256Hex(content);
}

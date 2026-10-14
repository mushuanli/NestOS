// @file: durable-kernel/src/infrastructure/seqfile/seqfile-core.ts
// SeqFile 基础设施原语：目录/文件布局、路径/键名、编码、事务、事件追加。
// 供 store.ts 与 store-helpers.ts 复用，消除单一巨型辅助文件。

import type { IFileSystem, ISeqFileOperations, ISeqFileTransaction } from '@itookit/vfs-core';
import type { EventEnvelope, ResolvedStorageBinding } from '../../domain/types';

export function join(...parts: string[]): string {
    return `/${parts.flatMap(part => part.split('/')).filter(Boolean).join('/')}`;
}

export function encode(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Value is not JSON serializable');
    return encoded;
}

export function decode<T = any>(value: string): T { return JSON.parse(value) as T; }

export function createId(prefix: string): string {
    const uuid = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${uuid}`;
}

// ── 路径 / 键名 ───────────────────────────────────────────────────────────────

export function catalogPath(root: string): string { return join(root, 'catalog.seq'); }
export function sessionPath(root: string): string { return join(root, 'session.seq'); }
export function sharedPath(root: string): string { return join(root, 'shared.seq'); }
export function contextPath(root: string): string { return join(root, 'context.seq'); }
export function messagesPath(root: string): string { return join(root, 'messages.seq'); }
export function resourcesPath(root: string): string { return join(root, 'resources.seq'); }
export function eventsPath(root: string): string { return join(root, 'events.seq'); }
export function indexPath(root: string): string { return join(root, 'index.seq'); }
export function graphPath(root: string): string { return join(root, 'graph.seq'); }
/** Logical IDs used in paths must be a single segment. UUID is not required. */
export function validateId(id: string): void {
    if (!id || id === '.' || id === '..' || /[/\\\u0000-\u001f]/.test(id)) throw new Error(`Invalid object ID: ${id}`);
}
export function taskPath(root: string, id: string): string { validateId(id); return join(root, 'tasks', id, 'task.seq'); }
export function attemptKey(id: string): string { return `attempt/${id}`; }
export function snapshotKey(version: number): string { return `snapshot/${String(version).padStart(16, '0')}`; }
export function taskWaitKey(targetId: string, waiterId: string): string {
    return `wait/task/${targetId}/${waiterId}`;
}
export function spawnMappingKey(parentId: string, key: string): string {
    return `spawn/${parentId}/${encodeURIComponent(key)}`;
}
export function outboxKey(id: string): string { return `outbox/${id}`; }
export function inboxKey(id: string): string { return `inbox/${id}`; }
export function sharedKey(key: string): string { return `value/${encodeURIComponent(key)}`; }
export function sharedHeadKey(key: string): string { return `head/${encodeURIComponent(key)}`; }
export function sharedHistoryPrefix(key: string): string { return `history/${encodeURIComponent(key)}/`; }
export function contextCommitKey(id: string): string { return `commit/${id}`; }
export function contextBranchKey(name: string): string { return `branch/${encodeURIComponent(name)}`; }
export function resourceKey(id: string): string { return `resource/${id}`; }
export function handleKey(id: string): string { return `handle/${id}`; }
export function budgetKey(resourceId: string, dimension: string): string {
    return `budget/${resourceId}/${encodeURIComponent(dimension)}`;
}
/** `usage/<encoded usageId>`: idempotent budget settlement receipt (see design §5). */
export function budgetUsageKey(usageId: string): string { return `usage/${encodeURIComponent(usageId)}`; }
export function workspaceSnapshotKey(id: string): string { return `workspace/snapshot/${id}`; }
export function workspaceDiffKey(id: string): string { return `workspace/diff/${id}`; }

// ── 布局 / 事务 ───────────────────────────────────────────────────────────────

/** Every SeqFile a Session root owns (their records are stored separately). */
export function sessionSeqFiles(root: string): string[] {
    return ['session.seq', 'shared.seq', 'context.seq', 'messages.seq', 'events.seq', 'graph.seq', 'resources.seq', 'index.seq']
        .map(file => join(root, file));
}

/**
 * Drop every record of the given SeqFiles. Deleting files never touches these
 * records, and leftovers would resurrect a removed Session under a reused identity.
 */
export async function clearSeqRecords(fs: IFileSystem, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await transaction(fs, async tx => {
        for (const path of paths) {
            const keys: string[] = [];
            await tx.walkEntries(path, entry => { keys.push(entry.key); return true; });
            for (const key of keys) await tx.deleteEntry(path, key);
        }
    });
}

/** Session seq files plus every Task seq file, from the tree and from the index records. */
export async function sessionRecordPaths(binding: ResolvedStorageBinding, taskIds: string[] = []): Promise<string[]> {
    const ids = new Set([...taskIds, ...await taskIdsFromIndex(binding.fs, binding.rootPath)]);
    return [...sessionSeqFiles(binding.rootPath), ...[...ids].map(id => taskPath(binding.rootPath, id))];
}

async function taskIdsFromIndex(fs: IFileSystem, root: string): Promise<string[]> {
    // Records are read through a transaction: the non-transactional SeqFile API
    // resolves the file first and would fail once the storage tree is gone.
    return transaction(fs, async tx => {
        const ids: string[] = [];
        await tx.walkEntries(indexPath(root), entry => {
            ids.push(entry.key.slice('task/'.length));
            return true;
        }, { keyPrefix: 'task/' });
        return ids;
    });
}

export async function ensureSessionLayout(binding: ResolvedStorageBinding): Promise<void> {
    requireTransactionalSeq(binding.fs);
    // A missing session file means this storage was removed; records may have
    // survived an interrupted removal, so this identity must start from empty.
    const fresh = !await binding.fs.driver.exists(join(binding.rootPath, 'session.seq'));
    await ensureTree(binding.fs, binding.rootPath);
    await binding.fs.driver.updateMetadata(binding.rootPath, { vfsFixedLayout: true });
    const files = sessionSeqFiles(binding.rootPath);
    const existing = await Promise.all(files.map(file => binding.fs.driver.exists(file)));
    for (const [index, file] of files.entries()) if (!existing[index]) await ensureSeqFile(binding.fs, file);
    await ensureTree(binding.fs, join(binding.rootPath, 'tasks'));
    if (fresh) await clearSeqRecords(binding.fs, await sessionRecordPaths(binding));
}

export async function ensureTaskLayout(binding: ResolvedStorageBinding, taskId: string): Promise<void> {
    validateId(taskId);
    const root = join(binding.rootPath, 'tasks', taskId);
    await ensureTree(binding.fs, root);
    await ensureTree(binding.fs, join(root, 'artifacts'));
    await ensureSeqFile(binding.fs, join(root, 'task.seq'));
}

export async function ensureTree(fs: IFileSystem, path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean), missing: string[] = [];
    while (parts.length) {
        if (await fs.driver.exists(`/${parts.join('/')}`)) break;
        missing.push(parts.pop()!);
    }
    for (const name of missing.reverse()) {
        const parentPath = parts.length ? `/${parts.join('/')}` : null;
        await fs.driver.createDirectory({ name, parentPath });
        parts.push(name);
    }
}

export async function ensureSeqFile(fs: IFileSystem, path: string): Promise<void> {
    if (await fs.driver.exists(path)) return;
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`Invalid SeqFile path: ${path}`);
    const parentPath = parts.length ? `/${parts.join('/')}` : null;
    await fs.driver.createFile({ name, parentPath, type: 'seqfile', content: '' });
}

export function requireTransactionalSeq(fs: IFileSystem): ISeqFileOperations {
    const operations = fs.meta.seq;
    if (!operations?.transaction) throw new Error(`Filesystem ${fs.viewId} lacks transactional SeqFile support`);
    return operations;
}

export function seq(fs: IFileSystem): ISeqFileOperations {
    if (!fs.meta.seq) throw new Error(`Filesystem ${fs.viewId} lacks SeqFile support`);
    return fs.meta.seq;
}

export function transaction<T>(fs: IFileSystem, operation: (tx: ISeqFileTransaction) => Promise<T>): Promise<T> {
    return requireTransactionalSeq(fs).transaction!(operation);
}

export async function appendEventTx(
    tx: ISeqFileTransaction,
    root: string,
    sessionId: string,
    taskId: string | undefined,
    type: string,
    payload?: unknown,
    identity?: { effectId: string; attemptId: string },
): Promise<number> {
    const sequence = await tx.increment(eventsPath(root), 'next-sequence');
    if (sequence === 1) await tx.setEntry(eventsPath(root), 'task-event-index-version', '1');
    const event: EventEnvelope = { schemaVersion: 1, ...identity, sequence, sessionId, taskId, type, payload, occurredAt: Date.now() };
    await tx.setEntry(eventsPath(root), `event/${String(sequence).padStart(16, '0')}`, encode(event));
    if (taskId && await tx.getEntry(eventsPath(root), 'task-event-index-version') === '1') await indexTaskEventTx(tx, root, event);
    return sequence;
}

export function taskEventCountKey(taskId: string): string { return `task-event-count/${encodeURIComponent(taskId)}`; }
/** First Task event index still retained on disk; absent means nothing was pruned yet. */
export function taskEventFirstKey(taskId: string): string { return `task-event-first/${encodeURIComponent(taskId)}`; }
export function taskEventKey(taskId: string, index: number): string { return `task-event/${encodeURIComponent(taskId)}/${String(index).padStart(16, '0')}`; }
export async function indexTaskEventTx(tx: ISeqFileTransaction, root: string, event: EventEnvelope): Promise<void> {
    if (!event.taskId) return;
    const index = await tx.increment(eventsPath(root), taskEventCountKey(event.taskId));
    if (!Number.isSafeInteger(index) || index < 1) throw new Error('Task event index exhausted');
    await tx.setEntry(eventsPath(root), taskEventKey(event.taskId, index), String(event.sequence));
}

/** Older stores lack the derived Task index; build it once atomically from authoritative events. */
export async function ensureTaskEventIndexTx(tx: ISeqFileTransaction, root: string): Promise<void> {
    const version = await tx.getEntry(eventsPath(root), 'task-event-index-version');
    if (version === '1') return;
    if (version !== null) throw new Error('Unsupported Task event index version');
    const events: EventEnvelope[] = [];
    await tx.walkEntries(eventsPath(root), row => { events.push(decode<EventEnvelope>(row.value)); return true; }, { keyPrefix: 'event/' });
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) await indexTaskEventTx(tx, root, event);
    await tx.setEntry(eventsPath(root), 'task-event-index-version', '1');
}

import { contextKey, createContextContentStore, type ContextGcView, type IContextGcStore } from '@itookit/llm-context';
import type { TaskRecord } from '@itookit/durable-kernel';
import type { IFileSystem, ISeqFileTransaction } from '@itookit/vfs-core';
import { createFileContextContentStore } from './file-content-store';

/** SeqFile bodies can be reclaimed without unpinning the Kernel's fixed directory layout. */
export function createTaskContextStorage(fs: IFileSystem, sessionRoot: string, taskId: string) {
    const root = `${sessionRoot}/tasks/${encodeURIComponent(taskId)}`;
    const taskPath = `${root}/task.seq`;
    const path = taskPath;
    const legacy = createFileContextContentStore(fs, `${root}/context-content`, false);
    const transaction = fs.meta.seq?.transaction?.bind(fs.meta.seq);
    if (!transaction) throw new Error('Context storage requires transactional SeqFiles');
    const content = createContextContentStore({
        get: async id => await fs.driver.exists(path) ? fs.meta.seq!.getEntry(path, `context-content/blob/${id}`) : null,
        putIfAbsent: (id, body) => transaction(tx => publish(tx, path, id, body)),
    });
    const read = async (ref: Parameters<typeof content.read>[0]) => {
        if (await fs.driver.exists(path) && await fs.meta.seq!.getEntry(path, `context-content/blob/${ref.id}`) !== null) return content.read(ref);
        return legacy.read(ref);
    };
    const gc: IContextGcStore = { async exclusive(work) {
        if (!await fs.driver.exists(path)) return null;
        return transaction(async tx => {
            if (!quiescent(await readTask(tx, taskPath))) return null;
            return work(gcView(tx, path, taskPath, `${sessionRoot}/shared.seq`, taskId, legacy.read));
        });
    } };
    return { content: { ...content, read }, gc };
}

async function publish(tx: ISeqFileTransaction, path: string, id: string, body: string): Promise<void> {
    const task = await readTask(tx, path);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) throw new Error('Cannot publish context for a terminal Task');
    if (await tx.getEntry(path, `context-content/blob/${id}`) !== null) return;
    await tx.setEntry(path, `context-content/blob/${id}`, body);
    await tx.setEntry(path, `context-content/meta/${id}`, JSON.stringify({ id, createdAt: Date.now(), bytes: new TextEncoder().encode(body).length }));
}

async function readTask(tx: ISeqFileTransaction, path: string): Promise<TaskRecord> {
    const raw = await tx.getEntry(path, 'record');
    if (!raw) throw new Error('Context owner Task is unavailable');
    return JSON.parse(raw);
}

function quiescent(task: TaskRecord): boolean {
    return ['succeeded', 'failed', 'cancelled'].includes(task.status) && Boolean(task.exit) && !task.currentAttempt
        && Object.values(task.effects).every(effect => !effect.cleanupPending && !effect.currentAttempt
            && ['succeeded', 'failed', 'cancelled'].includes(effect.status));
}

function gcView(tx: ISeqFileTransaction, path: string, taskPath: string, sharedPath: string,
    taskId: string, legacyRead: ContextGcView['read']): ContextGcView {
    const checked = createContextContentStore({ get: id => tx.getEntry(path, `context-content/blob/${id}`),
        putIfAbsent: async () => { throw new Error('Read-only GC view'); } });
    return {
        async *entries() { yield* rows<import('@itookit/llm-context').ContextGcEntry>(tx, path, 'context-content/meta/'); },
        async *roots() {
            yield* rows(tx, taskPath, '', 'context-content/');
            const prefix = encodeURIComponent(contextKey(taskId, ''));
            for (const kind of ['value/', 'history/']) yield* rows(tx, sharedPath, `${kind}${prefix}`);
        },
        async read(ref) {
            return await tx.getEntry(path, `context-content/blob/${ref.id}`) === null ? legacyRead(ref) : checked.read(ref);
        },
        async remove(id) {
            await tx.deleteEntry(path, `context-content/blob/${id}`);
            await tx.deleteEntry(path, `context-content/meta/${id}`);
        },
    };
}

async function* rows<T>(tx: ISeqFileTransaction, path: string, prefix: string, exclude?: string): AsyncGenerator<T> {
    let offset = 0;
    while (true) {
        const page: T[] = [];
        let scanned = 0;
        await tx.walkEntries(path, entry => {
            scanned++;
            if (!exclude || !entry.key.startsWith(exclude)) page.push(JSON.parse(entry.value));
            return true;
        },
            { keyPrefix: prefix, offset, limit: 64 });
        yield* page;
        if (scanned < 64) return;
        offset += scanned;
    }
}

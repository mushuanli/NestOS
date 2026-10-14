import { afterEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager } from '@itookit/vfs-core';
import { contextKey, createContextGc, createContextService, type IContextGcStore } from '@itookit/llm-context';
import { createTaskContextStorage } from './task-content-store';

const managers: IVFSManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); });
async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); managers.push(manager);
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/s/tasks/t', name: 'task.seq', type: 'seqfile', recursive: true });
    await fs.driver.createFile({ parentPath: '/s', name: 'shared.seq', type: 'seqfile' });
    await fs.driver.updateMetadata('/s', { vfsFixedLayout: true });
    const task = { id: 't', status: 'waiting', effects: {}, state: {}, exit: undefined as unknown };
    const writeTask = () => fs.meta.seq!.setEntry('/s/tasks/t/task.seq', 'record', JSON.stringify(task));
    await writeTask();
    const storage = createTaskContextStorage(fs, '/s', 't');
    const terminal = async () => { task.status = 'succeeded'; task.exit = { status: 'succeeded' }; await writeTask(); };
    return { fs, storage, task, writeTask, terminal };
}

it('pins active/uncommitted publications, then preserves snapshots and historical shared roots after restart', async () => {
    const f = await fixture();
    const service = createContextService({ content: f.storage.content, records: { get: async () => undefined } });
    const prepared = await service.prepare({ contextId: 't', operationId: 'p', request: {}, messages: [{ role: 'user', content: 'goal' }] });
    const spill = await service.admitOutput('evidence'.repeat(500), 1024);
    const historical = await f.storage.content.publish('old pinned evidence', 'text/plain');
    const orphan = await f.storage.content.publish('lost prepare', 'text/plain');
    const gc = createContextGc(f.storage.gc, { retentionMs: 0 });
    expect(await gc.collect()).toMatchObject({ status: 'busy', deleted: 0 });
    await f.fs.meta.seq!.setEntry('/s/tasks/t/task.seq', 'snapshot/0001', JSON.stringify({ prepared, spill }));
    await f.fs.meta.seq!.setEntry('/s/shared.seq', `history/${encodeURIComponent(contextKey('t', 'pin/evidence'))}/1`, JSON.stringify({ value: historical }));
    await f.terminal();
    const restored = createTaskContextStorage(f.fs, '/s', 't');
    expect(await createContextGc(restored.gc, { retentionMs: 0 }).collect()).toMatchObject({ status: 'collected', deleted: 1 });
    await expect(restored.content.read(orphan)).rejects.toThrow('missing or corrupt');
    expect(await restored.content.read(spill.contentRef!)).toBe('evidence'.repeat(500));
    expect(await restored.content.read(historical)).toBe('old pinned evidence');
    expect(await service.request(prepared.cursor)).toMatchObject({ contextId: 't', revision: 1 });
    await expect(restored.content.publish('late worker')).rejects.toThrow('terminal');
});

it('rolls back a partially failed sweep and waits for effect cleanup acknowledgement', async () => {
    const f = await fixture();
    const ref = await f.storage.content.publish('orphan', 'text/plain');
    await f.terminal();
    f.task.effects = { pending: { status: 'cancelled', cleanupPending: true } };
    await f.writeTask();
    expect(await createContextGc(f.storage.gc, { retentionMs: 0 }).collect()).toMatchObject({ status: 'busy' });
    f.task.effects = {}; await f.writeTask();
    const broken: IContextGcStore = { exclusive: work => f.storage.gc.exclusive(view => work({ ...view,
        async remove(id) { await view.remove(id); throw new Error('disk failure'); } })) };
    expect(await createContextGc(broken, { retentionMs: 0 }).collect()).toMatchObject({ status: 'failed', deleted: 0 });
    expect(await f.storage.content.read(ref)).toBe('orphan');
    expect(await createContextGc(f.storage.gc, { retentionMs: 0 }).collect()).toMatchObject({ deleted: 1 });
});

it('serializes competing collectors and refuses publication after the terminal fence', async () => {
    const f = await fixture(); await f.storage.content.publish('orphan', 'text/plain'); await f.terminal();
    const other = createTaskContextStorage(f.fs, '/s', 't');
    const results = await Promise.all([createContextGc(f.storage.gc, { retentionMs: 0 }).collect(),
        createContextGc(other.gc, { retentionMs: 0 }).collect()]);
    expect(results.map(result => result.deleted).sort()).toEqual([0, 1]);
    await expect(other.content.publish('orphan', 'text/plain')).rejects.toThrow('terminal');
});

it('scans beyond one metadata/root page without marking the content namespace itself', async () => {
    const f = await fixture();
    for (let index = 0; index < 70; index++) await f.storage.content.publish(`orphan-${index}`, 'text/plain');
    const kept = await f.storage.content.publish('keep', 'text/plain');
    f.task.state = { ref: kept }; await f.terminal();
    const gc = createContextGc(f.storage.gc, { retentionMs: 0, maxDeletes: 64 });
    expect(await gc.collect()).toMatchObject({ status: 'collected', scanned: 71, marked: 1, deleted: 64 });
    expect(await gc.collect()).toMatchObject({ scanned: 7, deleted: 6 });
    expect(await f.storage.content.read(kept)).toBe('keep');
});

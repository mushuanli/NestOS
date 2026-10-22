import { expect, it, vi, afterEach } from 'vitest';
import { createContextContentStore } from '../content/store';
import { createContextGc } from './collector';
import { scheduleContextGc } from './scheduler';
import type { ContextGcEntry, IContextGcStore } from './types';

function fixture() {
    const blobs = new Map<string, string>();
    const entries = new Map<string, ContextGcEntry>();
    const roots: unknown[] = [];
    const content = createContextContentStore({ get: async id => blobs.get(id) ?? null,
        putIfAbsent: async (id, body) => { blobs.set(id, body); entries.set(id, { id, createdAt: 100, bytes: new TextEncoder().encode(body).length }); } });
    const store: IContextGcStore = { exclusive: work => work({ read: content.read,
        async *roots() { yield* roots; }, async *entries() { yield* entries.values(); },
        async remove(id) { blobs.delete(id); entries.delete(id); } }) };
    return { content, roots, blobs, entries, store };
}

it('traces notes, linked history, and embedded spill refs before collecting only old orphans', async () => {
    const f = fixture();
    const evidence = await f.content.publish('original evidence', 'text/plain');
    const tail = await f.content.publish(JSON.stringify({ messages: [{ content: `read ref=${JSON.stringify(evidence)}` }] }));
    const head = await f.content.publish(JSON.stringify({ previous: tail, notes: { evidence: [evidence] } }));
    f.roots.push({ snapshot: head });
    const orphan = await f.content.publish('aborted', 'text/plain');
    const fresh = await f.content.publish('fresh', 'text/plain');
    f.entries.get(fresh.id)!.createdAt = 190;
    const gc = createContextGc(f.store, { retentionMs: 50 });
    expect(await gc.collect({ now: 200, dryRun: true })).toMatchObject({ status: 'dry-run', marked: 3, candidates: 1, deleted: 0 });
    expect(await gc.collect({ now: 200 })).toMatchObject({ status: 'collected', deleted: 1, reclaimedBytes: 7 });
    expect(f.blobs.has(orphan.id)).toBe(false);
    expect(await f.content.read(evidence)).toBe('original evidence');
    expect(f.blobs.has(fresh.id)).toBe(true);
    expect((await gc.collect({ now: 200 })).deleted).toBe(0);
});

it.each(['maxRoots', 'maxObjects', 'maxBytes', 'maxDurationMs'] as const)('does not sweep an incomplete mark when %s is exhausted', async budget => {
    const f = fixture(); f.roots.push(await f.content.publish('{}'));
    const orphan = await f.content.publish('orphan', 'text/plain');
    const result = await createContextGc(f.store, { [budget]: 0, retentionMs: 0 }).collect({ now: 200 });
    expect(result).toMatchObject({ status: 'budget', deleted: 0 });
    expect(f.blobs.has(orphan.id)).toBe(true);
});

it('aborts on corrupt reachable content and honors the deletion batch limit', async () => {
    const f = fixture(); const ref = await f.content.publish('{}'); f.roots.push(ref);
    await f.content.publish('one', 'text/plain'); await f.content.publish('two', 'text/plain');
    f.blobs.set(ref.id, 'corrupt');
    const gc = createContextGc(f.store, { retentionMs: 0, maxDeletes: 1 });
    expect(await gc.collect({ now: 200 })).toMatchObject({ status: 'failed', deleted: 0 });
    expect(f.blobs.size).toBe(3);
    f.blobs.set(ref.id, '{}');
    expect(await gc.collect({ now: 200 })).toMatchObject({ status: 'collected', candidates: 2, deleted: 1 });
    expect(await gc.collect({ now: 200 })).toMatchObject({ candidates: 1, deleted: 1 });
});

it('retains all candidates when a persisted reference has lost required metadata', async () => {
    const f = fixture();
    const ref = await f.content.publish('evidence', 'text/plain');
    await f.content.publish('orphan', 'text/plain');
    f.roots.push({ id: ref.id, sha256: ref.sha256 });
    expect(await createContextGc(f.store, { retentionMs: 0 }).collect()).toMatchObject({ status: 'failed', deleted: 0 });
    expect(f.blobs.size).toBe(2);
});

it('distinguishes input and task assets from context blobs without dropping reachable context', async () => {
    const f = fixture();
    const input = { kind: 'input', id: '0e2380bb-3690-47aa-a26b-51e219b8faef', mimeType: 'image/jpeg', bytes: 42, sha256: 'a'.repeat(64) };
    const taskAsset = { sessionId: 's', taskId: 't', owner: 'tasks/t/task.seq', name: 'asset.bin', mimeType: 'image/png', bytes: 24, sha256: 'b'.repeat(64) };
    const business = { id: 'invoice-42', sha256: 'c'.repeat(64) };
    const reachable = await f.content.publish(JSON.stringify({ input, taskAsset, business, preview: JSON.stringify(input) }));
    const orphan = await f.content.publish('orphan', 'text/plain');
    f.roots.push({ contentRef: reachable, assets: [input, taskAsset], business });
    expect(await createContextGc(f.store, { retentionMs: 0 }).collect({ now: 200 })).toMatchObject({ status: 'collected', marked: 1, candidates: 1, deleted: 1 });
    expect(f.blobs.has(reachable.id)).toBe(true);
    expect(f.blobs.has(orphan.id)).toBe(false);
    expect(await f.content.read(reachable)).toContain('image/jpeg');
});

it.each(['missing-bytes', 'wrong-type', 'renamed-media-type'])('fails closed for %s context metadata alongside image assets', async kind => {
    const f = fixture(), ref = await f.content.publish('reachable', 'text/plain');
    const corrupt: Record<string, unknown> = { ...ref };
    if (kind === 'missing-bytes') delete corrupt.bytes;
    if (kind === 'wrong-type') corrupt.sha256 = 42;
    if (kind === 'renamed-media-type') { delete corrupt.mediaType; corrupt.mimeType = 'text/plain'; }
    f.roots.push({ contentRef: corrupt, input: { kind: 'input', id: 'image-id', mimeType: 'image/jpeg', bytes: 42, sha256: 'a'.repeat(64) } });
    const orphan = await f.content.publish('orphan', 'text/plain');
    expect(await createContextGc(f.store, { retentionMs: 0 }).collect({ now: 200 })).toMatchObject({ status: 'failed', deleted: 0 });
    expect(f.blobs.has(ref.id)).toBe(true);
    expect(f.blobs.has(orphan.id)).toBe(true);
});

afterEach(() => vi.useRealTimers());
it('coalesces timer/manual passes, survives errors, and waits for work before disposal', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const schedule = scheduleContextGc(run, { initialDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    const manual = schedule.collect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = schedule.dispose().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await manual; await closing;
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    const onError = vi.fn();
    const failed = scheduleContextGc(async () => { throw new Error('offline'); }, { initialDelayMs: 1, intervalMs: 10, onError });
    await vi.advanceTimersByTimeAsync(21); await failed.dispose();
    expect(onError).toHaveBeenCalledTimes(3);
});

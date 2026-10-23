import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel, type JsonValue, type SessionHandle } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { SchedulerCheckpointWriter, readFlowSchedulerCheckpoint } from '../src/flow/checkpoint-store';
import type { SchedulerCheckpoint } from '../src/flow/scheduler-checkpoint';
import { acquireSchedulerLease, type SchedulerLease } from '../src/flow/scheduler-lease';
import { fenceSchedulerSession } from '../src/flow/fenced-session';

const root = 'root';
const pointerKey = `flow.run.${root}.scheduler`;
const componentPrefix = `${pointerKey}.frozen.`;
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

function checkpoint(): SchedulerCheckpoint {
    const node = { id: 'one', name: 'One', plugin: 'builtin.transform', pluginVersion: '1', inputs: {}, config: { value: 'x'.repeat(64 * 1024) } };
    return { version: 1, spec: { nodes: [node], edges: [] }, nodes: [node], edges: [],
        instances: [], completed: [], edgeState: [], delegationDepth: [], delegationGroups: [],
        delegationGroupByChild: [], skipped: [], detachedNodes: [], appliedPatches: [],
        nodeDefaults: [], nodeConnections: [], consumedTokens: 0, startedAt: 1,
        completionOrder: [], dispatchOrder: [], contextProgramVersion: '2' };
}

describe('scheduler checkpoint persistence', () => {
    let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, session: SessionHandle;
    const kernels: Kernel[] = [], leases: SchedulerLease[] = [];
    const makeKernel = async (catalog = '/catalog') => {
        const next = new Kernel({ catalog: { fs, rootPath: catalog }, maxConcurrent: 0, pollMs: 0 });
        next.registerStorageResolver({ kind: 'test', async resolve(ref) { return { fs, rootPath: ref.locator as string }; } });
        await next.initialize(); kernels.push(next); return next;
    };
    const own = async (ownerId: string) => {
        const lease = await acquireSchedulerLease(session, root, { ownerId }); leases.push(lease);
        return { lease, fenced: fenceSchedulerSession(session, lease.condition) };
    };
    const fromHistory = (value: JsonValue) => ({ getShared: async (key: string) => key === pointerKey
        ? { key, version: 1, value, updatedAt: 0 } : session.getShared(key) }) as Pick<SessionHandle, 'getShared'>;
    const interruptWrite = (base: SessionHandle, fail: (key: string) => boolean) => ({
        setShared: async (key: string, value: JsonValue, options?: Parameters<SessionHandle['setShared']>[2]) => {
            if (fail(key)) throw new Error('Injected checkpoint write failure');
            return base.setShared(key, value, options);
        },
    }) as Pick<SessionHandle, 'setShared'>;

    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
        fs = await manager.openFileSystem('/'); kernel = await makeKernel();
        session = await kernel.createSession({ id: 's', storage: { kind: 'test', locator: '/session' } });
    });
    afterEach(async () => {
        for (const lease of leases.splice(0)) await lease.release();
        for (const item of kernels.splice(0)) { item.dispose(); await item.waitIdle(); }
        await manager.dispose();
    });

    it('keeps retained bytes bounded by one large graph across repeated state updates', async () => {
        const writer = new SchedulerCheckpointWriter(), value = checkpoint(), updates = 32;
        const { fenced, lease } = await own('writer');
        for (let index = 0; index < updates; index++) {
            value.consumedTokens = index; value.completed = [`node-${index}`];
            await writer.save(fenced, root, lease.epoch, value);
        }
        const components = await session.listShared(componentPrefix);
        expect(components).toHaveLength(1);
        expect(await session.sharedHistory(components[0]!.key)).toHaveLength(1);
        expect(await session.sharedHistory(pointerKey)).toHaveLength(updates);
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(value);
        let storedBytes = 0;
        await fs.meta.seq!.walkEntries('/session/shared.seq', entry => {
            storedBytes += new TextEncoder().encode(entry.value).length; return true;
        });
        // Measure retained payload, not elapsed time: CI speed must not determine correctness.
        expect(storedBytes).toBeLessThan(bytes(value) * updates / 8);
        expect((await session.sharedHistory(pointerKey)).every(row => bytes(row) < 2048)).toBe(true);
    });

    it('preserves historical graph references when a dynamic patch changes the graph', async () => {
        const writer = new SchedulerCheckpointWriter(), first = checkpoint();
        await writer.save(session, root, 1, first);
        const saved = (await session.getShared(pointerKey))!.value;
        const second = structuredClone(first);
        second.nodes.push({ ...second.nodes[0]!, id: 'two', name: 'Two' });
        second.edges.push({ id: 'one-two', from: 'one', to: 'two' });
        second.appliedPatches.push(['patch', 'receipt']);
        await writer.save(session, root, 1, second);
        expect(await session.listShared(componentPrefix)).toHaveLength(2);
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(second);
        expect(await readFlowSchedulerCheckpoint(fromHistory(saved), root)).toEqual(first);
        const component = (await session.listShared(componentPrefix))[0]!;
        await expect(session.setShared(component.key, null, { expectedVersion: null })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await session.sharedHistory(component.key)).toHaveLength(1);
    });

    it('reads legacy and initial checkpoints, then reopens compact state without a writer cache', async () => {
        const value = checkpoint();
        expect(await readFlowSchedulerCheckpoint(session, root, value)).toEqual(value);
        await session.setShared(pointerKey, json(value));
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(value);
        await new SchedulerCheckpointWriter().save(session, root, 1, value);
        const replacement = await makeKernel();
        expect(await readFlowSchedulerCheckpoint(await replacement.openSession('s'), root)).toEqual(value);
    });

    it('exports and restores every immutable component referenced by historical checkpoints', async () => {
        const writer = new SchedulerCheckpointWriter(), first = checkpoint();
        await writer.save(session, root, 1, first);
        const second = structuredClone(first); second.parameters = { revision: 'new' };
        await writer.save(session, root, 1, second); await session.suspend();
        const lines: string[] = [];
        for await (const line of kernel.archives.exportSession('s', { purpose: 'recover' })) lines.push(line);
        const target = await makeKernel('/restored-catalog');
        await target.archives.importSession((async function* () { yield* lines; })(), {
            mode: 'restore', requestId: 'restore', storage: { kind: 'test', locator: '/restored' }, assertExclusive: async () => {},
        });
        const restored = await target.openSession('s');
        expect(await readFlowSchedulerCheckpoint(restored, root)).toEqual(second);
        const history = await restored.sharedHistory(pointerKey);
        const historical = { getShared: async (key: string) => key === pointerKey
            ? { key, version: 1, value: history[0]!.value!, updatedAt: 0 } : restored.getShared(key) } as Pick<SessionHandle, 'getShared'>;
        expect(await readFlowSchedulerCheckpoint(historical, root)).toEqual(first);
    });

    it.each(['component', 'pointer'])('leaves the old pointer readable after an interrupted %s write', async stage => {
        const writer = new SchedulerCheckpointWriter(), first = checkpoint();
        const { fenced, lease } = await own('writer');
        await writer.save(fenced, root, lease.epoch, first);
        const oldPointer = await session.getShared(pointerKey), next = structuredClone(first);
        next.parameters = { changed: true };
        const failing = interruptWrite(fenced, key => stage === 'pointer' ? key === pointerKey : key.startsWith(componentPrefix));
        await expect(writer.save(failing, root, lease.epoch, next)).rejects.toThrow('Injected checkpoint write failure');
        expect(await session.getShared(pointerKey)).toEqual(oldPointer);
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(first);
        await writer.save(fenced, root, lease.epoch, next);
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(next);
        expect(await session.sharedHistory(pointerKey)).toHaveLength(2);
    });

    it.each([false, true])('fences a stale writer even when the graph changed: %s', async changed => {
        const writer = new SchedulerCheckpointWriter(), value = checkpoint();
        const first = await own('first'); await writer.save(first.fenced, root, first.lease.epoch, value);
        const saved = await session.getShared(pointerKey);
        await first.lease.release(); const second = await own('second');
        value.consumedTokens++;
        if (changed) value.parameters = { changed: true };
        await expect(writer.save(first.fenced, root, first.lease.epoch, value)).rejects.toMatchObject({ code: 'STALE_SHARED_LEASE' });
        expect(await session.getShared(pointerKey)).toEqual(saved);
        expect(await session.listShared(componentPrefix)).toHaveLength(1);
        await new SchedulerCheckpointWriter().save(second.fenced, root, second.lease.epoch, value);
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(value);
    });

    it('keeps the old pointer if ownership changes after writing its new component', async () => {
        const writer = new SchedulerCheckpointWriter(), value = checkpoint();
        const first = await own('first'); await writer.save(first.fenced, root, first.lease.epoch, value);
        const saved = await session.getShared(pointerKey);
        const takeover = { setShared: async (key: string, payload: JsonValue, options?: Parameters<SessionHandle['setShared']>[2]) => {
            const entry = await first.fenced.setShared(key, payload, options);
            if (key.startsWith(componentPrefix)) { await first.lease.release(); await own('second'); }
            return entry;
        } } as Pick<SessionHandle, 'setShared'>;
        value.parameters = { changed: true };
        await expect(writer.save(takeover, root, first.lease.epoch, value)).rejects.toMatchObject({ code: 'STALE_SHARED_LEASE' });
        expect(await session.getShared(pointerKey)).toEqual(saved);
        expect(await session.listShared(componentPrefix)).toHaveLength(2);
        expect(await readFlowSchedulerCheckpoint(session, root)).toEqual(checkpoint());
    });

    it('rejects missing components instead of falling back to the initial checkpoint', async () => {
        const value = checkpoint(); await new SchedulerCheckpointWriter().save(session, root, 1, value);
        const component = (await session.listShared(componentPrefix))[0]!;
        await session.deleteShared(component.key);
        await expect(readFlowSchedulerCheckpoint(session, root, value)).rejects.toThrow('frozen component is missing');
    });

    it('rejects a stored null checkpoint instead of treating it as a missing value', async () => {
        await session.setShared(pointerKey, null);
        await expect(readFlowSchedulerCheckpoint(session, root, checkpoint())).rejects.toThrow('envelope');
        await expect(readFlowSchedulerCheckpoint(session, root)).rejects.toThrow('envelope');
    });

    it.each(['flow.run.other.scheduler.frozen.1.1', `${componentPrefix}0.1`, `${componentPrefix}1.0`, `${componentPrefix}1.1/other`])
    ('rejects an invalid or cross-run reference: %s', async frozenKey => {
        await session.setShared(pointerKey, { version: 2, frozenKey, state: { version: 1 } });
        await expect(readFlowSchedulerCheckpoint(session, root)).rejects.toThrow('frozen reference');
    });

    it('rejects a state overlay that attempts to replace immutable graph fields', async () => {
        const value = checkpoint(); await new SchedulerCheckpointWriter().save(session, root, 1, value);
        const saved = (await session.getShared(pointerKey))!.value as Record<string, JsonValue>;
        const state = saved.state as Record<string, JsonValue>;
        await session.setShared(pointerKey, { ...saved, state: { ...state, spec: { nodes: [], edges: [] } } });
        await expect(readFlowSchedulerCheckpoint(session, root)).rejects.toThrow('frozen reference');
    });

    it('rejects an overwritten component and unsupported checkpoint versions', async () => {
        await new SchedulerCheckpointWriter().save(session, root, 1, checkpoint());
        const component = (await session.listShared(componentPrefix))[0]!;
        await session.setShared(component.key, component.value, { expectedVersion: 1 });
        await expect(readFlowSchedulerCheckpoint(session, root)).rejects.toThrow('frozen component');
        await session.setShared(pointerKey, { version: 3 });
        await expect(readFlowSchedulerCheckpoint(session, root)).rejects.toThrow('Invalid Flow scheduler checkpoint');
    });
});

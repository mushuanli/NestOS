import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import { Kernel } from './application/kernel';
import { SeqFileKernelStore } from './infrastructure/seqfile/store';
import { addEffect } from './application/effect-utils';
import { resourcesPath, taskPath } from './infrastructure/seqfile/seqfile-core';
import type { ResolvedStorageBinding } from './domain/types';

describe('cache and mailbox retention', () => {
    let manager: IVFSManager, fs: IFileSystem, binding: ResolvedStorageBinding;
    let store: SeqFileKernelStore, kernel: Kernel;
    const spec = { program: { kind: 'test', version: '1' }, input: null };
    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
        fs = await manager.openFileSystem('/data/test'); binding = { fs, rootPath: '/session' };
        store = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => binding);
        await store.initialize(); await store.createSession('s', { kind: 'test', locator: null });
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', resolve: async () => binding });
        await kernel.initialize();
    });
    afterEach(async () => { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); });
    it('reclaims every cache namespace when the Session closes, including session scope', async () => {
        const task = await store.createTask(binding, 's', spec);
        const scratch = await store.createCache(binding, task.id, { name: 'scratch' });
        const shared = await store.createCache(binding, task.id, { name: 'shared', scope: 'session' });
        await store.publishCache(binding, task.id, { operationId: 'put-task', handleId: scratch.handle.id, key: 'k', fingerprint: 'v1', value: 'task', expectedGeneration: 1 });
        await store.publishCache(binding, task.id, { operationId: 'put-session', handleId: shared.handle.id, key: 'k', fingerprint: 'v1', value: 'session', expectedGeneration: 1 });
        await store.createResource(binding, {
            id: 'artifact-2', sessionId: 's', kind: 'artifact', uri: 'artifact://keep', generation: 1, createdAt: Date.now(),
        }, { id: 'artifact-2-handle', resourceId: 'artifact-2', holderTaskId: task.id, generation: 1, rights: ['read'] });
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        await store.commitTask(binding, claim, { ...claim.task, status: 'succeeded', currentAttempt: undefined }, 'task.succeeded');

        // The Task terminal pass keeps `session` scope; closing the Session reclaims it.
        const beforeClose: string[] = [];
        await fs.meta.seq!.walkEntries(resourcesPath(binding.rootPath), row => { beforeClose.push(row.key); return true; });
        expect(beforeClose).toContain(`cache/namespace/${shared.namespace.id}`);
        expect(beforeClose).not.toContain(`cache/namespace/${scratch.namespace.id}`);

        await store.setSessionStatus(binding, 'closing', 'cancel');
        await store.setSessionStatus(binding, 'closed');
        const keys: string[] = [];
        await fs.meta.seq!.walkEntries(resourcesPath(binding.rootPath), row => { keys.push(row.key); return true; });
        expect(keys.some(key => key.startsWith('cache/'))).toBe(false);
        expect(keys).not.toContain(`handle/${shared.handle.id}`);
        // Artifacts, their handles and Effect idempotency facts are not cache state.
        expect(keys).toContain('resource/artifact-2');
        expect(keys).toContain('handle/artifact-2-handle');
        expect(await fs.meta.seq!.getEntry(taskPath(binding.rootPath, task.id), 'cache-operation/put-session')).not.toBeNull();
        expect((await store.readTask(binding, task.id)).status).toBe('succeeded');
    });


    it('cleans Task-scope cache at Task terminal while keeping session scope and other facts', async () => {
        const task = await store.createTask(binding, 's', spec);
        const scratch = await store.createCache(binding, task.id, { name: 'scratch' });
        const shared = await store.createCache(binding, task.id, { name: 'shared', scope: 'session' });
        await store.publishCache(binding, task.id, { operationId: 'put-task', handleId: scratch.handle.id, key: 'k', fingerprint: 'v1', value: 'task', expectedGeneration: 1 });
        await store.publishCache(binding, task.id, { operationId: 'put-session', handleId: shared.handle.id, key: 'k', fingerprint: 'v1', value: 'session', expectedGeneration: 1 });
        await store.createResource(binding, {
            id: 'artifact-1', sessionId: 's', kind: 'artifact', uri: 'artifact://value', generation: 1, createdAt: Date.now(),
        }, { id: 'artifact-handle', resourceId: 'artifact-1', holderTaskId: task.id, generation: 1, rights: ['read'] });

        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        const request = { id: 'effect', kind: 'write', version: '1', idempotencyKey: 'key', request: null, timeoutMs: 100 };
        const withEffect = addEffect(claim.task, request);
        withEffect.effects.effect.status = 'succeeded';
        await store.commitTask(binding, claim, { ...withEffect, status: 'succeeded', currentAttempt: undefined }, 'task.succeeded');

        const keys: string[] = [];
        await fs.meta.seq!.walkEntries(resourcesPath(binding.rootPath), row => { keys.push(row.key); return true; });
        expect(keys).not.toContain(`cache/namespace/${scratch.namespace.id}`);
        expect(keys.some(key => key.startsWith(`cache/entry/${scratch.namespace.id}/`))).toBe(false);
        expect(keys).not.toContain(`resource/${scratch.namespace.id}`);
        expect(keys).not.toContain(`handle/${scratch.handle.id}`);
        expect(keys).toContain(`cache/namespace/${shared.namespace.id}`);
        expect(keys.some(key => key.startsWith(`cache/entry/${shared.namespace.id}/`))).toBe(true);
        // Idempotency facts and artifacts are not part of cache cleanup.
        expect((await store.readTask(binding, task.id)).effects.effect.status).toBe('succeeded');
        expect(keys).toContain('resource/artifact-1');
        expect(await fs.meta.seq!.getEntry(taskPath(binding.rootPath, task.id), 'cache-operation/put-task')).not.toBeNull();

        // A session-scope namespace outlives its creator: another Task still reads it.
        const reader = await store.createTask(binding, 's', spec);
        const readerHandle = await store.grantResource(binding, 'reader-handle', shared.handle.id, reader.id, ['read']);
        expect(await store.readCache(binding, reader.id, { operationId: 'read-after-terminal',
            sources: [{ handleId: readerHandle.id, key: 'k', fingerprint: 'v1' }] })).toMatchObject({ status: 'hit', value: 'session' });
    });


    it('rebuilds a legacy cache owner index before terminal cleanup', async () => {
        const task = await store.createTask(binding, 's', spec);
        const cache = await store.createCache(binding, task.id, { name: 'legacy' });
        const path = resourcesPath(binding.rootPath);
        await fs.meta.seq!.deleteEntry(path, `cache/owner/${encodeURIComponent(task.id)}/${cache.namespace.id}`);
        await fs.meta.seq!.deleteEntry(path, 'cache/owner-index-version');
        const claim = (await store.claimReady(binding, 'worker', 10000))!;
        await store.commitTask(binding, claim, { ...claim.task, status: 'succeeded', currentAttempt: undefined }, 'task.succeeded');
        expect(await fs.meta.seq!.getEntry(path, `cache/namespace/${cache.namespace.id}`)).toBeNull();
    });


    it('refuses terminal cleanup through an owner index pointing to another Task cache', async () => {
        const owner = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const victim = await store.createCache(binding, owner.id, { name: 'keep' });
        const task = await store.createTask(binding, 's', spec);
        await store.createCache(binding, task.id, { name: 'own' });
        const path = resourcesPath(binding.rootPath);
        await fs.meta.seq!.setEntry(path, `cache/owner/${encodeURIComponent(task.id)}/${victim.namespace.id}`,
            JSON.stringify({ id: victim.namespace.id }));
        const claim = (await store.claimReady(binding, 'worker', 10000))!;
        await expect(store.commitTask(binding, claim, { ...claim.task, status: 'succeeded', currentAttempt: undefined }, 'task.succeeded'))
            .rejects.toThrow('Cache owner index mismatch');
        expect(await fs.meta.seq!.getEntry(path, `cache/namespace/${victim.namespace.id}`)).not.toBeNull();
        expect((await store.readTask(binding, task.id)).status).toBe('running');
    });


    it('keeps a consumed cross-session receipt until the source settles delivery', async () => {
        const targetBinding = { fs, rootPath: '/target' };
        const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => targetBinding);
        await targetStore.createSession('target', { kind: 'test', locator: null });
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const receiver = await targetStore.createTask(targetBinding, 'target', spec);
        const init = (await targetStore.claimReady(targetBinding, 'worker', 10000))!;
        await targetStore.commitTask(targetBinding, init, { ...init.task, initialized: true, state: null,
            status: 'waiting', currentAttempt: undefined, wait: { type: 'message', topic: 'work' } }, 'task.waiting');
        const message = await store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'unsettled',
            targetSessionId: 'target', targetTaskId: receiver.id, topic: 'work', payload: 'once' });
        await targetStore.deliverMessage(targetBinding, message);
        const claim = (await targetStore.claimReady(targetBinding, 'worker', 10000))!;
        await targetStore.commitTask(targetBinding, claim, { ...claim.task, pendingEvents: [], status: 'waiting',
            currentAttempt: undefined, wait: { type: 'signal' } }, 'task.waiting');
        expect((await targetStore.messageReceipt(targetBinding, message.id)).consumedAt).toBeTypeOf('number');
        expect(await store.pendingOutbox(binding)).toHaveLength(1);
        expect(await targetStore.pruneMessages(targetBinding, Date.now() + 1)).toEqual({ outbox: 0, inbox: 0 });
        expect(await targetStore.deliverMessage(targetBinding, message)).toBe(false);
        expect((await targetStore.readTask(targetBinding, receiver.id))!.pendingEvents).toEqual([]);
    });


    it('keeps cross-session delivery responsibility while both stores run retention', async () => {
        // Source and target live in different stores, so retention runs independently.
        const targetBinding = { fs, rootPath: '/target' };
        const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => targetBinding);
        await targetStore.createSession('target', { kind: 'test', locator: { rootPath: '/target' } });
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const receiver = await targetStore.createTask(targetBinding, 'target', spec);
        // The receiver waits for the message; consumption only commits for an initialized Task.
        const init = (await targetStore.claimReady(targetBinding, 'w', 10_000))!;
        await targetStore.commitTask(targetBinding, init, { ...init.task, initialized: true, state: null,
            status: 'waiting', currentAttempt: undefined, wait: { type: 'message', topic: 'work' } }, 'task.waiting');
        const message = await store.sendTaskMessage(binding, sender.id,
            { idempotencyKey: 'cross', targetSessionId: 'target', targetTaskId: receiver.id, topic: 'work', payload: 'work' });
        const earlyWatermark = Date.now() + 1;

        // An undelivered message survives retention on the source side.
        expect(await store.pruneMessages(binding, earlyWatermark)).toEqual({ outbox: 0, inbox: 0 });
        expect((await store.outbox(binding)).map(item => item.id)).toEqual([message.id]);

        // Delivery settles the source record; the target receipt is still unconsumed and
        // must survive retention on the target side.
        expect(await targetStore.deliverMessage(targetBinding, message)).toBe(true);
        await store.markMessageDelivered(binding, message.id, await targetStore.messageReceipt(targetBinding, message.id));
        expect(await store.pendingOutbox(binding)).toHaveLength(1);
        const settled = (await store.outbox(binding))[0];
        await targetStore.acknowledgeMessageSettlement(targetBinding, settled, 'inbox');
        await store.acknowledgeMessageSettlement(binding, settled, 'outbox');
        expect(await store.pendingOutbox(binding)).toHaveLength(0);
        // A watermark taken after delivery reclaims the settled source record, while the
        // unconsumed target receipt (in its own store) is still protected.
        const lateWatermark = Date.now() + 1;
        expect(await store.pruneMessages(binding, lateWatermark)).toEqual({ outbox: 1, inbox: 0 });
        expect(await targetStore.pruneMessages(targetBinding, lateWatermark)).toEqual({ outbox: 0, inbox: 0 });
        expect((await targetStore.inbox(targetBinding)).map(item => item.id)).toEqual([message.id]);

        // Consuming the receipt settles it, so the next pass may reclaim it.
        const claim = (await targetStore.claimReady(targetBinding, 'w', 10_000))!;
        expect(claim.task.id).toBe(receiver.id);
        expect(claim.task.pendingEvents.map(event => event.type)).toEqual(['message']);
        await targetStore.commitTask(targetBinding, claim, { ...claim.task, pendingEvents: [], status: 'waiting',
            currentAttempt: undefined, wait: { type: 'signal' } }, 'task.waiting');
        expect((await targetStore.inbox(targetBinding)).find(item => item.id === message.id)?.consumedAt).toBeTypeOf('number');
        expect(await targetStore.pruneMessages(targetBinding, Date.now() + 1)).toEqual({ outbox: 0, inbox: 1 });
        expect(await targetStore.inbox(targetBinding)).toHaveLength(0);
    });


    it('prunes settled messages only, keeping undelivered and unconsumed records', async () => {
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const receiver = await store.createTask(binding, 's', spec);
        const init = (await store.claimReady(binding, 'w', 10_000))!;
        await store.commitTask(binding, init, { ...init.task, initialized: true, state: null, status: 'waiting',
            currentAttempt: undefined, wait: { type: 'message', topic: 'work' } }, 'task.waiting');

        const request = (idempotencyKey: string, payload: string) =>
            ({ idempotencyKey, targetSessionId: 's', targetTaskId: receiver.id, topic: 'work', payload });
        const consumed = await store.sendTaskMessage(binding, sender.id, request('consumed', 'a'));
        const unconsumed = await store.sendTaskMessage(binding, sender.id, request('unconsumed', 'b'));
        // Consuming the first pending event settles exactly one receipt.
        const claimed = (await store.claimReady(binding, 'w', 10_000))!;
        await store.commitTask(binding, claimed, { ...claimed.task, pendingEvents: [], status: 'waiting',
            currentAttempt: undefined, wait: { type: 'message', topic: 'work' } }, 'task.waiting');
        expect((await store.inbox(binding)).find(message => message.id === consumed.id)?.consumedAt).toBeTypeOf('number');

        // Queued for a Session that never appears: delivery responsibility stays.
        const undelivered = await store.sendTaskMessage(binding, sender.id,
            { idempotencyKey: 'undelivered', targetSessionId: 'later', targetTaskId: 'x', topic: 'work', payload: 'c' });
        // A delivered receipt whose sender has not recorded delivery yet must survive too.
        const halfDelivered = await store.sendTaskMessage(binding, sender.id,
            { idempotencyKey: 'half', targetSessionId: 'later', targetTaskId: 'x', topic: 'work', payload: 'd' });
        await store.deliverMessage(binding, { ...halfDelivered, targetSessionId: 's', targetTaskId: receiver.id });

        expect(await store.pruneMessages(binding, Date.now() + 1)).toEqual({ outbox: 2, inbox: 1 });
        // Delivered outbox records are settled; anything still pending keeps both its
        // delivery responsibility and the matching receipt.
        const outbox = (await store.outbox(binding)).map(message => message.id);
        expect(outbox).not.toContain(consumed.id);
        expect(outbox).not.toContain(unconsumed.id);
        expect(outbox).toContain(undelivered.id);
        expect(outbox).toContain(halfDelivered.id);
        const inbox = (await store.inbox(binding)).map(message => message.id);
        expect(inbox).not.toContain(consumed.id);
        expect(inbox).toContain(unconsumed.id);
        expect(inbox).toContain(halfDelivered.id);
        // A watermark older than the records keeps everything (replay window).
        expect(await store.pruneMessages(binding, 1)).toEqual({ outbox: 0, inbox: 0 });
    });


    it.each(['pending', 'settled', 'reclaimed'])('recovers settlement without redelivery at %s', async phase => {
        const targetBinding = { fs, rootPath: '/target' };
        const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => targetBinding);
        await targetStore.createSession('target', { kind: 'test', locator: { rootPath: '/target' } });
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const receiver = await targetStore.createTask(targetBinding, 'target', spec);
        const init = (await targetStore.claimReady(targetBinding, 'worker', 10000))!;
        await targetStore.commitTask(targetBinding, init, { ...init.task, initialized: true, state: null,
            status: 'waiting', currentAttempt: undefined, wait: { type: 'message', topic: 'work' } }, 'task.waiting');
        const message = await store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'unsettled',
            targetSessionId: 'target', targetTaskId: receiver.id, topic: 'work', payload: 'once' });
        await targetStore.deliverMessage(targetBinding, message);
        const claim = (await targetStore.claimReady(targetBinding, 'worker', 10000))!;
        await targetStore.commitTask(targetBinding, claim, { ...claim.task, pendingEvents: [], status: 'waiting',
            currentAttempt: undefined, wait: { type: 'signal' } }, 'task.waiting');
        expect((await targetStore.messageReceipt(targetBinding, message.id)).consumedAt).toBeTypeOf('number');
        const settled = phase === 'pending' ? message
            : await store.markMessageDelivered(binding, message.id, await targetStore.messageReceipt(targetBinding, message.id));
        expect(await store.pruneMessages(binding, Date.now() + 1)).toEqual({ outbox: 0, inbox: 0 });
        if (phase === 'reclaimed') {
            await targetStore.acknowledgeMessageSettlement(targetBinding, settled, 'inbox');
            expect(await targetStore.pruneMessages(targetBinding, Date.now() + 1)).toEqual({ outbox: 0, inbox: 1 });
        }
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', resolve: async reference =>
            (reference.locator as { rootPath?: string } | null)?.rootPath === '/target' ? targetBinding : binding });
        await kernel.initialize(); await kernel.relayPendingMessages();
        expect(await store.pendingOutbox(binding)).toHaveLength(0);
        expect((await targetStore.readTask(targetBinding, receiver.id))!.pendingEvents).toEqual([]);
        expect(await store.pruneMessages(binding, Date.now() + 1)).toEqual({ outbox: 1, inbox: 0 });
        expect(await targetStore.pruneMessages(targetBinding, Date.now() + 1)).toEqual({ outbox: 0, inbox: phase === 'reclaimed' ? 0 : 1 });
    });


    it.each([-1, 0.5, NaN, Infinity])('rejects invalid message GC limit %s without mutating records', async limit => {
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'pending', targetSessionId: 'missing',
            targetTaskId: 'target', topic: 'work', payload: null });
        const before = await store.outbox(binding);
        await expect(store.pruneMessages(binding, Date.now() + 1, limit)).rejects.toThrow('Invalid message retention limit');
        expect(await store.outbox(binding)).toEqual(before);
    });
    it.each([-1, NaN, Infinity])('rejects invalid message GC watermark %s', async before => {
        await expect(store.pruneMessages(binding, before)).rejects.toThrow('Invalid message retention watermark');
    });

});

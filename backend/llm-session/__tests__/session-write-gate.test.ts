import { afterEach, describe, expect, it } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionDirectoryStorageResolver } from '../src/persistence/session-directory-storage';
import { SessionRepository } from '../src/persistence/session-repository';
import { SessionManager } from '../src/session/session-manager';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup = [];
});

async function fixture(canWriteSession: (sessionId: string) => Promise<boolean>) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/module/test');
    const kernel = new Kernel({ catalog: { fs } });
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
    await kernel.initialize();
    cleanup.push(async () => { kernel.dispose(); await kernel.waitIdle(); });
    const engine = new SessionRepository(fs);
    await engine.init();
    cleanup.push(() => engine.dispose());
    const sessionId = await engine.createSession('Session');
    const managerInstance = new SessionManager(engine, { getAgentConfig: async (id: string) => id === 'memory-agent' ? {
        id, memoryPolicy: { namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'] },
    } : undefined } as never, {
        kernel, dagPlugins: {} as never, flowStore: {} as never, canWriteSession,
    });
    cleanup.push(async () => managerInstance.destroy());
    await managerInstance.bindSession(sessionId);
    return { engine, sessionId, sessionManager: managerInstance };
}

describe('Session single-writer gate', () => {
    it('keeps a pending memory edit bound to its original Session when the UI switches', async () => {
        let approve!: (allowed: boolean) => void;
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const decision = new Promise<boolean>(resolve => { approve = resolve; });
        const f = await fixture(async () => { entered(); return decision; });
        const pending = f.sessionManager.memory.upsert('memory-agent', { entryId: 'note', scope: 'project', content: 'first Session' });
        await waiting;
        const second = await f.engine.createSession('Second');
        await f.sessionManager.bindSession(second);
        approve(true);
        await pending;
        expect(await f.sessionManager.memory.list('memory-agent')).toEqual([]);
        await f.sessionManager.bindSession(f.sessionId);
        expect((await f.sessionManager.memory.list('memory-agent'))[0].content).toBe('first Session');
    });
    it('manages memory using the selected Agent policy and enforces the host write lease', async () => {
        let writable = true;
        const checked: string[] = [];
        const f = await fixture(async id => { checked.push(id); return writable; });
        const memory = f.sessionManager.memory;
        await memory.upsert('memory-agent', { entryId: 'note', scope: 'project', content: 'original' });
        const [entry] = await memory.list('memory-agent');
        expect(entry.content).toBe('original');
        await expect(memory.upsert('memory-agent', { entryId: 'note', scope: 'private', content: 'secret' })).rejects.toThrow('denied');
        await expect(memory.list('missing')).rejects.toThrow('no memory policy');
        writable = false;
        await expect(memory.upsert('memory-agent', { entryId: 'note', scope: 'project', content: 'changed' })).rejects.toThrow('another host');
        await expect(memory.remove('memory-agent', 'project', 'note')).rejects.toThrow('another host');
        expect((await memory.list('memory-agent'))[0].content).toBe('original');
        expect(new Set(checked)).toEqual(new Set([f.sessionId]));
        writable = true;
        await memory.remove('memory-agent', 'project', 'note', { expectedContentHash: entry.contentHash });
        expect(await memory.list('memory-agent')).toEqual([]);
    });
    it('refuses to start a run for a Session another host owns, before writing anything', async () => {
        const checked: string[] = [];
        const f = await fixture(async sessionId => { checked.push(sessionId); return false; });

        await expect(f.sessionManager.sendMessage('hello', [], 'default'))
            .rejects.toThrow('Session is owned by another host; this host can only read it');
        await expect(f.sessionManager.rerunFlow({}, 'source')).rejects.toThrow('another host');
        expect(checked).toEqual([f.sessionId, f.sessionId]);
        // The refusal happens before the round is appended.
        expect(await f.engine.listHistory(f.sessionId)).toEqual([]);
    });

    it('checks the Session this host would write to', async () => {
        const checked: string[] = [];
        const f = await fixture(async sessionId => { checked.push(sessionId); return true; });

        // With the lease held the gate passes; the run then fails later for lack of a usable
        // agent, which is not what this test is about.
        await f.sessionManager.sendMessage('hello', [], 'default').catch(() => undefined);
        expect(checked).toEqual([f.sessionId]);
    });
});

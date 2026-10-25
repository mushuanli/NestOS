import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createFlowInvocationSessions } from '../src/persistence/flow-invocation-sessions';

afterEach(() => vi.restoreAllMocks());

const MARKER = '/var/lib/kernel/flow-invocations.json';

async function withRoot(run: (fs: Awaited<ReturnType<Awaited<ReturnType<typeof createVFS>>['manager']['openFileSystem']>>) => Promise<void>) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try { await run(await manager.openFileSystem('/')); }
    finally { await manager.dispose(); }
}

it('reports unknown before the first mark and persists the marked Sessions', async () => {
    await withRoot(async fs => {
        const first = createFlowInvocationSessions(fs);
        expect(await first.sessions()).toBeUndefined();
        await first.mark('session-a');
        await first.mark('session-a');
        expect([...(await first.sessions())!]).toEqual(['session-a']);
        // A later boot reads the same storage through a fresh instance.
        expect([...(await createFlowInvocationSessions(fs).sessions())!]).toEqual(['session-a']);
        await first.mark('session-b');
        expect(new Set(await first.sessions())).toEqual(new Set(['session-a', 'session-b']));
    });
});

it('keeps concurrent marks for different Sessions', async () => {
    await withRoot(async fs => {
        const marker = createFlowInvocationSessions(fs);
        await Promise.all(['a', 'b', 'c'].map(id => marker.mark(id)));
        expect(new Set(await marker.sessions())).toEqual(new Set(['a', 'b', 'c']));
        expect(new Set(await createFlowInvocationSessions(fs).sessions())).toEqual(new Set(['a', 'b', 'c']));
    });
});

it('treats a corrupt or foreign marker as unknown and replaces it on the next mark', async () => {
    await withRoot(async fs => {
        await fs.driver.createFile({ name: 'flow-invocations.json', parentPath: '/var/lib/kernel', content: 'not json', recursive: true });
        const marker = createFlowInvocationSessions(fs);
        expect(await marker.sessions()).toBeUndefined();
        await marker.mark('session-a');
        expect([...(await createFlowInvocationSessions(fs).sessions())!]).toEqual(['session-a']);
        await fs.driver.writeContent(MARKER, JSON.stringify({ version: 99, sessions: ['other'] }));
        expect(await createFlowInvocationSessions(fs).sessions()).toBeUndefined();
    });
});

it.each(['create', 'update'] as const)('does not cache an uncommitted %s and persists a later retry', async mode => {
    await withRoot(async fs => {
        const marker = createFlowInvocationSessions(fs);
        if (mode === 'update') await marker.mark('existing');
        const failure = Object.assign(new Error('Marker storage unavailable'), {code: 'EIO'});
        const write = mode === 'create' ? vi.spyOn(fs.driver, 'createFile') : vi.spyOn(fs.driver, 'writeContent');
        write.mockRejectedValueOnce(failure);
        await expect(marker.mark('new-session')).rejects.toBe(failure);
        expect(await marker.sessions()).toEqual(mode === 'create' ? undefined : new Set(['existing']));
        await marker.mark('new-session');
        expect(await createFlowInvocationSessions(fs).sessions()).toEqual(new Set(mode === 'create' ? ['new-session'] : ['existing', 'new-session']));
        expect(write).toHaveBeenCalledTimes(2);
    });
});

it('does not advertise a failed probe seal or skip its next required mark', async () => {
    await withRoot(async fs => {
        const marker = createFlowInvocationSessions(fs); await marker.mark('existing');
        vi.spyOn(fs.driver, 'writeContent').mockRejectedValueOnce(new Error('Seal write failed'));
        await expect(marker.establish(['existing', 'recovered'])).rejects.toThrow('Seal write failed');
        expect(await marker.sessions()).toEqual(new Set(['existing']));
        await marker.mark('recovered');
        expect(await createFlowInvocationSessions(fs).sessions()).toEqual(new Set(['existing', 'recovered']));
    });
});

it('re-reads a committed marker after its write reply is lost before retrying admission', async () => {
    await withRoot(async fs => {
        const marker = createFlowInvocationSessions(fs); await marker.mark('existing');
        const original = fs.driver.writeContent.bind(fs.driver);
        const write = vi.spyOn(fs.driver, 'writeContent').mockImplementationOnce(async (...args) => {
            await original(...args); throw new Error('Lost write reply');
        });
        await expect(marker.mark('new-session')).rejects.toThrow('Lost write reply');
        await marker.mark('new-session');
        expect(write).toHaveBeenCalledOnce();
        expect(await createFlowInvocationSessions(fs).sessions()).toEqual(new Set(['existing', 'new-session']));
    });
});

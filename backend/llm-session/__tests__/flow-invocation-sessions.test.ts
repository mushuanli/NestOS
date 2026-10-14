import { expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createFlowInvocationSessions } from '../src/persistence/flow-invocation-sessions';

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

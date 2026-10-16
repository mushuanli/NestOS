import { expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../../src/runtime/create-application-runtime';
import { openApplicationView } from '../../src/host/application-view';

it('gives clients independent bindings over the same persisted application and closes views independently', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false});
    const first = await openApplicationView(runtime), second = await openApplicationView(runtime);
    try {
        const one = await runtime.projects.sessions.create('One', null), two = await runtime.projects.sessions.create('Two', null);
        const openedOne = await first.backend.openSessionView(one), openedTwo = await second.backend.openSessionView(two);
        await openedOne.activate(); await openedTwo.activate();
        expect(first.services.sessionManager.getSnapshot().sessionId).toBe(one);
        expect(second.services.sessionManager.getSnapshot().sessionId).toBe(two);
        expect((await first.services.sessionRepository.getManifest(two)).title).toBe('Two');
        expect(first.close()).toBe(first.close()); await first.close();
        expect(second.services.sessionManager.getSnapshot().sessionId).toBe(two);
        expect((await second.services.projects.sessions.get(one)).title).toBe('One');
    } finally { await first.close(); await second.close(); await runtime.dispose(); }
});

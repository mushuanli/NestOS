import { expect, it, vi } from 'vitest';
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

it('reconciles committed draft submissions from browser-owned conversation views', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        await runtime.projects.ensureStartup();
        const project = await runtime.projects.personal(), folder = await runtime.projects.sessionFolder(project);
        const draft = await runtime.projects.drafts.open(project.project.id, folder), prepared = await draft.prepare();
        const submission = prepared.submission!;
        await runtime.sessionRepository.writeDocument(prepared.sessionId, `round-${submission.id}.json`, JSON.stringify({
            id: submission.id, sessionId: prepared.sessionId, submission,
            input: [{role: 'user', content: 'Fixture message'}], executions: [{taskId: 'fixture-task', role: 'primary'}],
        }));
        await runtime.sessionRepository.updateManifest(prepared.sessionId, {rootRoundId: submission.id, currentHead: submission.id, branches: {main: submission.id}});
        const promoted = vi.fn(); const release = runtime.projects.drafts.onPromoted(promoted);
        (view.sessionManager as any).registry.eventBus.emitGlobal({type: 'execution_task_projected', payload: {
            sessionId: prepared.sessionId, roundId: submission.id, taskId: 'fixture-task', submission,
        }});
        await vi.waitFor(() => expect(promoted).toHaveBeenCalledOnce());
        const next = await draft.refresh?.(); expect(next?.initialData).toBe(''); release();
    } finally {await view.dispose(); await runtime.dispose();}
});

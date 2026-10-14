import { it, expect, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { ProjectDraftStore } from '../src/projects/drafts/store';
import { ProjectDraftService } from '../src/projects/drafts/service';

async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/'), repo = new SessionRepository(fs); await repo.init();
    const lifecycle = new ProjectDraftService(id => new ProjectDraftStore(fs, id), repo, async () => ['p']);
    const draft = new ProjectDraftStore(fs, 'p'); await draft.load(); await draft.saveData('unsent payload');
    const intent = await draft.begin('2026-09-29 12-00-00');
    const source = { id: intent.submissionId!, source: { kind: 'project-draft', ownerId: 'p', id: intent.id } };
    await repo.ensureSession(intent.sessionId!, intent.title!);
    const accept = async (patch = {}, committed = true) => { await repo.writeDocument(intent.sessionId!, `round-${intent.submissionId}.json`, JSON.stringify({
        id: intent.submissionId, sessionId: intent.sessionId, submission: source,
        input: [{ role: 'user', content: 'hello' }], executions: [{ taskId: 'task', role: 'primary' }], ...patch,
    }));
        if (committed) await repo.updateManifest(intent.sessionId!, { rootRoundId: intent.submissionId!, currentHead: intent.submissionId!, branches: { main: intent.submissionId! } });
    };
    return { manager, fs, repo, lifecycle, draft, intent, source, accept };
}

it('only durable first-message evidence promotes a draft; unrelated Session creation leaves it alone', async () => {
    const f = await fixture(), notify = vi.fn(); f.lifecycle.onPromoted(notify);
    try {
        await f.repo.createSession('CLI or imported'); await f.lifecycle.recover();
        expect((await new ProjectDraftStore(f.fs, 'p').load()).id).toBe(f.intent.id);
        await f.accept({}, false); await f.lifecycle.recover(); expect(notify).not.toHaveBeenCalled();
        await f.accept({ submission: { ...f.source, source: { ...f.source.source, id: 'other' } } }); await f.lifecycle.recover();
        expect(notify).not.toHaveBeenCalled();
        await f.accept({ executions: [] }); await f.lifecycle.recover(); expect(notify).not.toHaveBeenCalled();
        await f.accept(); await f.lifecycle.recover(f.intent.sessionId, f.intent.submissionId);
        const next = await new ProjectDraftStore(f.fs, 'p').load();
        expect(next).toMatchObject({ state: 'draft', data: '' }); expect(next.id).not.toBe(f.intent.id);
        expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            type: 'project.draftPromoted', draftId: f.intent.id, sessionId: f.intent.sessionId, nextDraftId: next.id,
        }));
        await expect(f.draft.saveData('late write')).rejects.toMatchObject({ code: 'ECONFLICT' });
        await f.lifecycle.recover(); expect(notify).toHaveBeenCalledOnce();
    } finally { await f.manager.dispose(); }
});

it('recovers a lost notification and creates only one successor across concurrent recovery', async () => {
    const f = await fixture();
    try {
        await f.accept();
        const restarted = new ProjectDraftService(id => new ProjectDraftStore(f.fs, id), f.repo, async () => ['p']);
        const notify = vi.fn(); restarted.onPromoted(notify); f.lifecycle.onPromoted(notify);
        await Promise.all([restarted.recover(), f.lifecycle.recover()]);
        expect(notify).toHaveBeenCalledOnce();
        const next = await new ProjectDraftStore(f.fs, 'p').load();
        const raw = await f.fs.meta.seq!.getEntry('/var/lib/projects/p/draft.seq', `promotion/${f.intent.id}`);
        expect(JSON.parse(raw!)).toMatchObject({ state: 'promoted', nextDraftId: next.id });
        await restarted.recover(); expect((await new ProjectDraftStore(f.fs, 'p').load()).id).toBe(next.id);
        expect(await restarted.submissionForSession('p', f.intent.sessionId!)).toBeUndefined();
    } finally { await f.manager.dispose(); }
});

it('retains the same submission identity for explicit retry of an unaccepted reserved Session', async () => {
    const f = await fixture();
    try {
        expect(await f.lifecycle.submissionForSession('p', f.intent.sessionId!)).toEqual(f.source);
        expect((await new ProjectDraftStore(f.fs, 'p').load()).data).toBe('unsent payload');
        const other = await f.repo.createSession('ordinary');
        expect(await f.lifecycle.submissionForSession('p', other)).toBeUndefined();
    } finally { await f.manager.dispose(); }
});

it('accepts legacy persisted origin through the receipt adapter without leaking it into new submissions', async () => {
    const f = await fixture();
    try {
        await f.accept({ submission: undefined, projectDraft: {
            projectId: 'p', draftId: f.intent.id, submissionId: f.intent.submissionId,
        } });
        await f.lifecycle.recover();
        expect((await new ProjectDraftStore(f.fs, 'p').load()).id).not.toBe(f.intent.id);
    } finally { await f.manager.dispose(); }
});

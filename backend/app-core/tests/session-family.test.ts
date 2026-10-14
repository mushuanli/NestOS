import { expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import type { ConversationManifest } from '@itookit/llm-session';
import { sessionFamilyRoots } from '../src/projects/session-family';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

it('makes descendants, orphans and damaged cycles reachable without recursive navigation', () => {
    const sessions = [
        { id: 'a' }, { id: 'b', parentSessionId: 'a' }, { id: 'c', parentSessionId: 'b' },
        { id: 'orphan', parentSessionId: 'missing' },
        { id: 'x', parentSessionId: 'y' }, { id: 'y', parentSessionId: 'x' },
    ] as ConversationManifest[];
    const roots = sessionFamilyRoots(sessions);
    expect(roots.get('c')).toBe('a'); expect(roots.get('orphan')).toBe('orphan');
    expect(roots.get('x')).toBe('x'); expect(roots.get('y')).toBe('x');
});

it('resumes a confirmed deletion on restart, retaining children and shared project files', async () => {
    const databaseName = `session-family-${crypto.randomUUID()}`;
    const first = await createApplicationRuntime({ backend: new IndexedDBBackend({ databaseName }), ownerKind: 'web' });
    let child: string, parent: string, projectPath: string;
    try {
        const project = (await first.projects.current())!; projectPath = project.path;
        const folder = await first.projects.sessionFolder(project);
        parent = await first.sessionRepository.createSession('Parent', folder);
        child = await first.sessionRepository.createSession('Child', folder, parent);
        const files = await first.projects.openFiles(project.path);
        await files.fs.driver.createFile({ parentPath: '/', name: 'keep.md', content: 'shared' }); await files.dispose();
        await first.sessionRepository.prepareSessionDeletion(parent);
    } finally { await first.dispose(); }
    const second = await createApplicationRuntime({ backend: new IndexedDBBackend({ databaseName }), ownerKind: 'web' });
    try {
        await expect(second.sessionRepository.getManifest(parent!)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await second.sessionRepository.getManifest(child!)).parentSessionId).toBeNull();
        expect(await second.sessionRepository.pendingSessionDeletions()).toEqual([]);
        const files = await second.projects.openFiles(projectPath!);
        expect(await files.fs.driver.readContent('/keep.md', { encoding: 'utf-8' })).toBe('shared'); await files.dispose();
    } finally { await second.dispose(); }
});

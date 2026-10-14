import { afterEach, describe, expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { exportSessionBundle, importSessionBundle, isSessionBundle, SESSION_BUNDLE_VERSION } from '../src/session/session-bundle';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });

async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init(); cleanup.push(() => repository.dispose());
    return { repository };
}

async function seeded() {
    const { repository } = await setup();
    await repository.createFolder('/Work');
    const id = await repository.createSession('Branching', '/Work');
    await repository.writeDocument(id, 'round-r1.json', JSON.stringify({ id: 'r1', input: [{ role: 'user', content: 'first' }], output: [] }));
    await repository.writeDocument(id, 'round-r2.json', JSON.stringify({ id: 'r2', input: [{ role: 'user', content: 'second' }], output: [] }));
    await repository.updateManifest(id, {
        branches: { main: 'r1', dev: 'r2' }, currentBranch: 'dev', currentHead: 'r2', rootRoundId: 'r1',
        branchMeta: { dev: { createdAt: 1, createdFrom: 'regenerate', forkedFromBranch: 'main', sourceRoundId: 'r1', branchRootRoundId: 'r2' } },
        children: { r1: ['r2'] }, uiState: { scrollPosition: 42 },
    });
    await repository.saveSessionSettings(id, { historyLength: 7 });
    await repository.writeAttachment(id, 'note.txt', new TextEncoder().encode('hello').buffer);
    return { repository, id };
}

describe('Session bundle', () => {
    it('round-trips the index, settings, documents and attachments', async () => {
        const { repository, id } = await seeded();
        const exported = await exportSessionBundle(repository, id);
        expect(JSON.parse(exported.content).version).toBe(SESSION_BUNDLE_VERSION);

        const restored = await importSessionBundle(repository, exported.content, { folder: '/Work' });
        const manifest = await repository.getManifest(restored);
        expect(manifest.title).toBe('Branching');
        expect(manifest.currentBranch).toBe('dev');
        expect(manifest.currentHead).toBe('r2');
        expect(manifest.branches).toEqual({ main: 'r1', dev: 'r2' });
        expect(manifest.rootRoundId).toBe('r1');
        expect(manifest.children).toEqual({ r1: ['r2'] });
        expect(manifest.branchMeta.dev).toMatchObject({ sourceRoundId: 'r1' });
        expect(manifest.uiState).toMatchObject({ scrollPosition: 42 });
        expect((await repository.getSessionSettings(restored)).historyLength).toBe(7);
        expect(await repository.readDocument(restored, 'round-r2.json')).toContain('second');
        const assets = await repository.openAttachments(restored);
        try {
            expect(new TextDecoder().decode(await assets.driver.readContent('/note.txt', { encoding: 'binary' }))).toBe('hello');
        } finally { await assets.dispose(); }
    });

    it('uses the import target folder instead of the folder recorded in the bundle', async () => {
        const { repository, id } = await seeded();
        const exported = await exportSessionBundle(repository, id);

        const atRoot = await importSessionBundle(repository, exported.content, { folder: null });
        expect((await repository.getManifest(atRoot)).folder ?? null).toBeNull();

        const fromBundle = await importSessionBundle(repository, exported.content);
        expect((await repository.getManifest(fromBundle)).folder).toBe('/Work');

        const before = (await repository.list()).length;
        await expect(importSessionBundle(repository, exported.content, { folder: '/Missing' })).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await repository.list()).length).toBe(before);
    });

    it('restores a legacy version 1 bundle including its branch index', async () => {
        const { repository } = await setup();
        const legacy = JSON.stringify({
            version: 1,
            manifest: { title: 'Legacy', currentBranch: 'main', currentHead: 'r1', rootRoundId: 'r1',
                branches: { main: 'r1' }, branchMeta: {}, children: { r1: [] } },
            history: { 'round-r1.json': JSON.stringify({ id: 'r1', input: [], output: [] }) },
        });
        expect(isSessionBundle(legacy)).toBe(true);
        const id = await importSessionBundle(repository, legacy);
        const manifest = await repository.getManifest(id);
        expect(manifest.title).toBe('Legacy');
        expect(manifest.currentHead).toBe('r1');
        expect(manifest.branches).toEqual({ main: 'r1' });
    });

    it('rejects a bundle whose index points at a missing round and leaves no Session', async () => {
        const { repository, id } = await seeded();
        const bundle = JSON.parse((await exportSessionBundle(repository, id)).content);
        delete bundle.documents['round-r2.json'];
        const before = (await repository.list()).length;
        await expect(importSessionBundle(repository, JSON.stringify(bundle))).rejects.toMatchObject({ code: 'EINVAL' });
        expect((await repository.list()).length).toBe(before);
    });

    it('rejects a round document whose identity does not match its filename', async () => {
        const { repository, id } = await seeded();
        const bundle = JSON.parse((await exportSessionBundle(repository, id)).content);
        bundle.documents['round-r2.json'] = JSON.stringify({ id: 'other' });
        await expect(importSessionBundle(repository, JSON.stringify(bundle))).rejects.toMatchObject({ code: 'EINVAL' });
        expect((await repository.list()).length).toBe(1);
    });

    it('rejects malformed documents without leaving a partial Session', async () => {
        const { repository } = await setup();
        const broken = JSON.stringify({
            format: 'itookit.session', version: SESSION_BUNDLE_VERSION,
            manifest: { title: 'Broken', branches: { main: null }, currentBranch: 'main', currentHead: null, rootRoundId: null, branchMeta: {}, children: {} },
            settings: {}, documents: { 'round-r1.json': 'not json' }, attachments: [],
        });
        await expect(importSessionBundle(repository, broken)).rejects.toMatchObject({ code: 'EINVAL' });
        expect(await repository.list()).toEqual([]);
    });

    it('treats plain text as a new empty Session rather than a bundle', async () => {
        const { repository } = await setup();
        expect(isSessionBundle('plain text')).toBe(false);
        const id = await repository.createSession('plain text');
        expect((await repository.getManifest(id)).title).toBe('plain text');
    });
});

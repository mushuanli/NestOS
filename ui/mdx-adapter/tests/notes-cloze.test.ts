// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { defaultEditorFactory } from '../src/factory';
import { CLOZE_SRS_PATH, clozeDocumentPrefix } from '@itookit/app-contracts';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('stores notes review state in the document seqfile instead of node metadata', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'notes', type: 'directory' });
    await fs.driver.createFile({ parentPath: '/notes', name: 'hello.mind', content: '--alpha-- and --beta--' });
    const mount = document.createElement('div'); document.body.append(mount);
    const editor = await defaultEditorFactory(mount, {
        target: { kind: 'file', path: '/notes/hello.mind' },
        contentFormat: 'markdown',
        initialContent: '--alpha-- and --beta--',
        // Notes workspace opts into spaced-repetition clozes; other workspaces do not.
        plugins: ['cloze:cloze'],
        files: { fs },
        hostContext: { saveContent: async () => {}, toggleSidebar() {}, navigate: async () => {} },
    });
    try {
        const cards = mount.querySelectorAll<HTMLElement>('.mdx-cloze');
        expect(cards).toHaveLength(2);
        // A fresh card is hidden; the first click reveals it and asks for a grade.
        const alpha = cards[0]!;
        expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
        alpha.click();
        const grade = alpha.querySelector<HTMLButtonElement>('.mdx-memory__panel button[data-grade="3"]');
        expect(grade).not.toBeNull();
        expect(grade!.textContent).toContain('一般');
        expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
        grade!.click();

        const seqPath = CLOZE_SRS_PATH, prefix = clozeDocumentPrefix('/notes/hello.mind');
        await vi.waitFor(async () => expect(await fs.meta.seq!.getEntry(seqPath, prefix + 'card:' + alpha.dataset.clozeLocator)).toBeTruthy());
        const stored = JSON.parse((await fs.meta.seq!.getEntry(seqPath, prefix + 'card:' + alpha.dataset.clozeLocator))!);
        expect(stored).toMatchObject({ v: 1, reviewCount: 1, lastGrade: 3 });

        // The document node keeps no review blob in metadata.
        const node = await fs.driver.getNode('/notes/hello.mind');
        expect(node?.metadata?._mdx_plugin_cloze).toBeUndefined();
        expect(await fs.meta.seq!.getEntry(seqPath, prefix + 'card:' + cards[1]!.dataset.clozeLocator)).toBeNull();
    } finally { await editor.destroy(); await manager.dispose(); }
}, 30_000);

it('keeps the cloze toolbar out of documents without clozes', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'notes', type: 'directory' });
    await fs.driver.createFile({ parentPath: '/notes', name: 'plain.mind', content: '# plain note\n\nnothing to review' });
    const mount = document.createElement('div'); document.body.append(mount);
    const editor = await defaultEditorFactory(mount, {
        target: { kind: 'file', path: '/notes/plain.mind' },
        contentFormat: 'markdown',
        initialContent: '# plain note\n\nnothing to review',
        plugins: ['cloze:cloze'],
        files: { fs },
        hostContext: { saveContent: async () => {}, toggleSidebar() {}, navigate: async () => {} },
    });
    try {
        expect(mount.querySelector('.mdx-cloze')).toBeNull();
        expect(mount.querySelector('.mdx-cloze-controls')).toBeNull();
    } finally { await editor.destroy(); await manager.dispose(); }
}, 30_000);

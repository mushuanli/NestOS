// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { CoreTitleBarPlugin } from '@itookit/mdxeditor';
import { renameDocument } from '../src/document-host';

it('renames from the actual filename, preserving its suffix until explicitly replaced', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'notes.prj', content: 'keep' });
    const container = document.createElement('div'); document.body.append(container);
    const events = new Map<string, Array<(payload: any) => void>>();
    const listen = (name: string, callback: (payload: any) => void) => {
        events.set(name, [...events.get(name) ?? [], callback]); return () => {};
    };
    const emit = (name: string, payload: unknown) => events.get(name)?.forEach(callback => callback(payload));
    let path = '/notes.prj';
    const editor = { getMode: () => 'edit', container, config: { title: 'notes', documentPath: path, host: { renameDocument: (current: string, title: string) => renameDocument(fs, current, title) } },
        updateDocumentPath: (next: string) => { path = next; editor.config.documentPath = next; },
        setTitle: (title: string) => emit('setTitle', { title }),
    };
    const context = { listen, on: listen, getFileSystem: () => fs, getCurrentNodeId: () => path };
    const plugin = new CoreTitleBarPlugin();
    try {
        plugin.install(context as any);
        emit('editorPostInit', { editor, pluginManager: { getTitleBarButtons: () => [] } });
        const input = container.querySelector('input')!;
        expect(input.value).toBe('notes');
        for (const [requested, filename, title] of [
            ['draft', 'draft.prj', 'draft'],
            ['draft.md', 'draft.md', 'draft'],
            ['final', 'final.md', 'final'],
            ['final.md', 'final.md', 'final'],
        ]) {
            const previous = path;
            input.value = requested; input.dispatchEvent(new Event('blur'));
            await vi.waitFor(() => { expect(path).toBe('/' + filename); expect(input.value).toBe(title); });
            expect(await fs.driver.readContent(path, { encoding: 'utf-8' })).toBe('keep');
            if (previous !== path) expect(await fs.driver.exists(previous)).toBe(false);
        }
    } finally { plugin.destroy(); container.remove(); await manager.dispose(); }
});

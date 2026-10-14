import { createLocalBackendPort } from '@itookit/app-core/host';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { SessionFilesService } from '@itookit/app-core';
import type { Kernel } from '@itookit/durable-kernel';
import type { EditorFactory } from '@itookit/ui-common';
import { SessionWorkbench } from '../src/projects/SessionWorkbench';

afterEach(() => vi.unstubAllGlobals());

it.each([null, '/Work'])('orders Sessions by latest activity with stable timestamp ties in %s', async folder => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    const files = new SessionFilesService(fs); await files.initialize();
    if (folder) await repository.createFolder(folder);
    const now = vi.spyOn(Date, 'now');
    try {
        for (const [id, time] of [['old', 1000], ['new', 2000], ['tie-b', 3000], ['tie-a', 3000]] as const) {
            now.mockReturnValue(time);
            await repository.ensureSession(id, id, 'tauri', folder);
        }
    } finally { now.mockRestore(); }
    const prefix = folder ? '/folder:Work' : '';
    const restored = {
        activeId: `${prefix}/old`, expandedFolderIds: folder ? [prefix] : [], selectedItemIds: [],
        uiSettings: { sortBy: folder ? 'title' as const : 'lastModified' as const },
    };
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory: EditorFactory = async (_container, options) => {
        if (options.target?.kind !== 'session') throw new Error('Expected Session target');
        await repository.updateUIState(options.target.sessionId, { historyVisibility: 'hidden' });
        return { destroy() {} } as never;
    };
    const kernel = { onChanged: () => () => {} } as unknown as Kernel;
    const createWorkbench = () => new SessionWorkbench({ backend: createLocalBackendPort(),  sidebar: sidebar, container: main, repository: repository, files: files, factory: factory, onSelect: () => {}, hostContext: undefined, kernel: kernel, fileFactory: factory, uiPersistence: { load: () => restored } });
    let workbench = createWorkbench();
    const order = () => [...sidebar.querySelectorAll<HTMLElement>('.vfs-node-item[data-item-id]')]
        .map(node => node.dataset.itemId!.slice(prefix.length + 1)).filter(id => ['old', 'new', 'tie-a', 'tie-b'].includes(id));
    let expected = ['tie-a', 'tie-b', 'new', 'old'];
    try {
        await workbench.start();
        await vi.waitFor(() => expect(order()).toEqual(expected));
        for (const id of ['new', 'old', 'tie-b']) {
            await workbench.openResource(`${prefix}/${id}`);
            await repository.updateManifest(id, { title: `Renamed ${id}`, currentBranch: 'review' });
            await vi.waitFor(() => expect(sidebar.textContent).toContain(`Renamed ${id}`));
            expected = [id, ...expected.filter(value => value !== id)];
            await vi.waitFor(() => expect(order()).toEqual(expected));
        }
        await new Promise(resolve => setTimeout(resolve, 180));
        const list = vi.spyOn(repository, 'list');
        await repository.updateUIState('old', { branchDrafts: { main: { inputText: 'new draft' } } });
        await new Promise(resolve => setTimeout(resolve, 180));
        expect(list).not.toHaveBeenCalled(); list.mockRestore();
        expected = ['old', ...expected.filter(value => value !== 'old')];
        await workbench.destroy(); workbench = createWorkbench();
        await workbench.start();
        await vi.waitFor(() => expect(order()).toEqual(expected));
    } finally {
        await workbench.destroy(); await files.dispose(); await repository.dispose(); await manager.dispose();
        sidebar.remove(); main.remove();
    }
});

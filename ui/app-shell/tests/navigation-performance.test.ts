// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { bindApplicationBackend } from '@itookit/app-core/host';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';
import { Workbench } from '../src/core/Workbench';
import { withInitialDirectory } from '../src/browser/initial-directory';
import { VfsJsonStore } from '../src/persistence/vfs-json-store';
import { VfsUIPersistence } from '../src/persistence/vfs-ui-state-store';
import { scheduleNavigationWarmup } from '../src/navigation/navigation-warmup';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    await root.driver.createDirectory({ parentPath: '/home/admin', name: 'minds', recursive: true });
    const fs = await manager.openFileSystem('/home/admin/minds');
    await fs.driver.createFile({ parentPath: '/', name: 'note.md', content: 'body' });
    const backend = bindApplicationBackend({ vfs: manager } as LocalApplicationServices);
    return { manager, fs, backend };
}
it('consumes one aggregated root and UI snapshot without secondary reads or creating an editor', async () => {
    const f = await fixture();
    await f.fs.driver.createFile({ parentPath: '/', name: '.gitignore', content: 'hidden.log\n' });
    await f.fs.driver.createFile({ parentPath: '/', name: 'hidden.log', content: 'hidden' });
    const view = await f.backend.navigationView({ root: '/home/admin/minds', scope: 'minds' });
    const fs = withInitialDirectory(view.files.fs, view.directory), reads = vi.spyOn(f.fs.driver, 'readContent'), listing = vi.spyOn(f.fs.driver, 'getChildren'), type = vi.spyOn(f.fs.driver, 'getNodeType');
    const uiRead = vi.spyOn(f.backend, 'readUiDocuments'), store = new VfsJsonStore(f.backend); store.seed(view.documents);
    const state = new VfsUIPersistence(store), sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
    const [uiPersistence, workbenchState] = await Promise.all([state.port('minds'), state.workbenchPort('minds')]);
    const factory = vi.fn();
    const workbench = new Workbench({ files: { fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: editor, editorFactory: factory,
        fileTypes: [{ extensions: ['.md', '.log'] }], uiPersistence, workbenchState }); cleanup.push(() => workbench.destroy());
    await workbench.start();
    expect(sidebar.textContent).toContain('note'); expect(sidebar.textContent).not.toContain('hidden.log');
    expect(uiRead).not.toHaveBeenCalled(); expect(listing).not.toHaveBeenCalled(); expect(type).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
    await f.fs.driver.writeContent('/.gitignore', 'note.md\n');
    await workbench.refresh();
    expect(sidebar.textContent).not.toContain('note.md'); expect(sidebar.textContent).toContain('hidden');
    expect(listing).toHaveBeenCalled(); expect(reads).toHaveBeenCalled();
});
it('reuses a clean hidden workbench and refreshes after a mutation while hidden', async () => {
    const f = await fixture(), sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
    const workbench = new Workbench({ files: { fs: f.fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: editor,
        editorFactory: vi.fn(), fileTypes: [{ extensions: ['.md'] }] }); cleanup.push(() => workbench.destroy());
    await workbench.start();
    const listing = vi.spyOn(f.fs.driver, 'getChildren');
    await workbench.setVisible(false); await workbench.setVisible(true); expect(listing).not.toHaveBeenCalled();
    await workbench.setVisible(false);
    await f.fs.driver.createFile({ parentPath: '/', name: 'new.md', content: 'new' });
    expect(listing).not.toHaveBeenCalled();
    await workbench.setVisible(true); expect(listing).toHaveBeenCalledOnce(); expect(sidebar.textContent).toContain('new');
});
it('renders the first level while a restored child directory remains blocked', async () => {
    const f = await fixture(); await f.fs.driver.createDirectory({ parentPath: '/', name: 'folder' });
    await f.fs.driver.createFile({ parentPath: '/folder', name: 'child.md', content: 'child' });
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; }), original = f.fs.driver.getChildren.bind(f.fs.driver);
    vi.spyOn(f.fs.driver, 'getChildren').mockImplementation(async (path, options) => { if (path === '/folder') await blocked; return original(path, options); });
    const sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
    const workbench = new Workbench({ files: { fs: f.fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: editor,
        editorFactory: vi.fn(), uiPersistence: { load: () => ({ expandedFolderIds: ['/folder'] }), save() {} } });
    cleanup.push(async () => { finish(); await workbench.destroy(); });
    await workbench.start(); expect(sidebar.textContent).toContain('folder');
    expect(sidebar.textContent).not.toContain('child'); finish();
    await vi.waitFor(() => expect(sidebar.textContent).toContain('child'));
});
it('revalidates a normal workbench if hiding interrupts a refresh', async () => {
    const f = await fixture(), sidebar = document.createElement('div'), editor = document.createElement('div');
    document.body.append(sidebar, editor);
    const workbench = new Workbench({ files: { fs: f.fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: editor, editorFactory: vi.fn() });
    cleanup.push(() => workbench.destroy()); await workbench.start();
    const original = f.fs.driver.getChildren.bind(f.fs.driver);
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; }); cleanup.push(() => finish());
    const reads = vi.spyOn(f.fs.driver, 'getChildren').mockImplementationOnce(async (...args) => { await blocked; return original(...args); });
    const refresh = workbench.refresh(); await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce());
    await workbench.setVisible(false); finish(); await refresh;
    await workbench.setVisible(true); expect(reads).toHaveBeenCalledTimes(2);
});
it('runs preparation serially after idle and cancels the remaining work when the app closes', async () => {
    vi.useFakeTimers(); const warm = vi.fn(async () => {});
    let finish!: () => void;
    const toolbox = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const close = scheduleNavigationWarmup([toolbox, warm]);
    expect(toolbox).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(2000);
    expect(toolbox).toHaveBeenCalledOnce(); expect(warm).not.toHaveBeenCalled();
    finish(); await vi.advanceTimersByTimeAsync(200); expect(warm).toHaveBeenCalledOnce(); close();
    const cancel = scheduleNavigationWarmup([warm]); cancel();
    await vi.advanceTimersByTimeAsync(5000); expect(warm).toHaveBeenCalledOnce();
    const inFlight = scheduleNavigationWarmup([toolbox, warm]);
    await vi.advanceTimersByTimeAsync(200); inFlight(); finish();
    await vi.advanceTimersByTimeAsync(5000); expect(warm).toHaveBeenCalledOnce();
});
it('yields to foreground loads, resumes on visibility, and continues after a failed preload', async () => {
    vi.useFakeTimers(); let busy = true;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fail = vi.fn(async () => { throw new Error('offline'); }), warm = vi.fn(async () => {});
    const close = scheduleNavigationWarmup([fail, warm], () => busy);
    await vi.advanceTimersByTimeAsync(1000); expect(fail).not.toHaveBeenCalled();
    hidden.mockReturnValue(true); busy = false;
    await vi.advanceTimersByTimeAsync(1000); expect(fail).not.toHaveBeenCalled();
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(400);
    expect(fail).toHaveBeenCalledOnce(); expect(warm).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce(); close();
});
it('discards initial metadata when an observed mutation precedes the first tree read', async () => {
    const f = await fixture();
    const view = await f.backend.navigationView({ root: '/home/admin/minds', scope: 'minds' });
    const fs = withInitialDirectory(view.files.fs, view.directory);
    const sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
    const workbench = new Workbench({ files: { fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: editor, editorFactory: vi.fn() });
    cleanup.push(() => workbench.destroy());
    await f.fs.driver.createFile({ parentPath: '/', name: 'fresh.md', content: 'fresh' });
    const listing = vi.spyOn(f.fs.driver, 'getChildren');
    await workbench.start();
    expect(listing).toHaveBeenCalledOnce(); expect(sidebar.textContent).toContain('fresh');
});

it('revalidates on a later revisit so unobserved external writes do not leave the tree cached indefinitely', async () => {
    const f = await fixture(), now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
    const workbench = new Workbench({ files: { fs: f.fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: editor, editorFactory: vi.fn() });
    cleanup.push(() => workbench.destroy()); await workbench.start();
    const listing = vi.spyOn(f.fs.driver, 'getChildren');
    await workbench.setVisible(false); now.mockReturnValue(15001); await workbench.setVisible(true);
    expect(listing).toHaveBeenCalledOnce();
});

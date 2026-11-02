// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {PageWindows} from '../src/workspaces/page-windows';
import {WorkbenchWindows} from '../src/workbench/windows';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {CalendarWorkbench} from '../src/calendar';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks();});
function fixture(initialResource = '/one') {
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const registry = new WorkbenchWindows(), selected = vi.fn(), pages: Array<{input: HTMLInputElement; destroy: ReturnType<typeof vi.fn>; visible: ReturnType<typeof vi.fn>}> = [];
    let workbench!: PageWindows;
    workbench = new PageWindows({sidebar, editor, title: 'Pages', initialResource, selected,
        windows: {registry, id: 'pages', isActive: () => true, navigate: path => workbench.openResource(path)},
        create: host => {
            const input = document.createElement('input'), destroy = vi.fn(async () => {}), visible = vi.fn(); host.editor.append(input);
            let path = '/one'; pages.push({input, destroy, visible});
            return {start: async () => {host.selected(path);}, openResource: async id => {path = id; host.selected(path);}, getActiveResourceId: () => path,
                destroy, setVisible: visible, captureRecovery: () => {if (input.value) throw new Error('UNSAVED'); return null;}, restoreRecovery: vi.fn()};
        }});
    cleanup.push(() => workbench.destroy());
    return {workbench, sidebar, editor, registry, pages, selected};
}
it('uses the shared sidebar button, preserves pages and refuses to close drafts', async () => {
    const f = fixture(); await f.workbench.start();
    const button = f.sidebar.querySelector<HTMLButtonElement>('.vfs-window-management')!;
    expect(button.getAttribute('aria-label')).toContain('(1)');
    f.pages[0]!.input.value = 'draft'; await f.workbench.openResource('/two');
    expect(f.registry.items()).toHaveLength(2); expect(button.getAttribute('aria-label')).toContain('(2)');
    await f.registry.items().find(item => item.id === '/one')!.activate();
    expect(f.pages[0]!.input.value).toBe('draft'); expect(f.pages).toHaveLength(2);
    await expect(f.registry.items().find(item => item.id === '/one')!.close()).rejects.toThrow('UNSAVED');
    expect(f.pages[0]!.destroy).not.toHaveBeenCalled();
    f.pages[0]!.input.value = ''; await f.registry.items().find(item => item.id === '/one')!.close();
    expect(f.pages[0]!.destroy).toHaveBeenCalledOnce();
    await f.workbench.destroy(); expect(f.registry.items()).toHaveLength(0);
});
it('reuses the canonical initial page when returning to the root route', async () => {
    const f = fixture('/'); await f.workbench.start(); await f.workbench.openResource('/');
    expect(f.pages).toHaveLength(1); expect(f.registry.items()[0]!.id).toBe('/one');
    expect(f.selected).toHaveBeenLastCalledWith('/one');
});
it('adapts the real calendar while preserving the selected date in its window', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const files = await manager.openFileSystem('/'), sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new PageWindows({sidebar, editor, title: 'Calendar', initialResource: '/2026-11-01', selected: vi.fn(),
        create: host => new CalendarWorkbench({...host, files, scanners: async () => {}, showNavigationTitle: false})});
    cleanup.push(() => workbench.destroy()); await workbench.start();
    expect(workbench.getActiveResourceId()).toBe('/2026-11-01');
    expect(sidebar.querySelector('.vfs-window-management')).not.toBeNull(); expect(sidebar.querySelector('h2')).toBeNull();
    await workbench.openResource('/2026-12-01'); await workbench.openResource('/2026-11-01');
    expect(editor.querySelectorAll('.calendar')).toHaveLength(2); expect(workbench.getActiveResourceId()).toBe('/2026-11-01');
});

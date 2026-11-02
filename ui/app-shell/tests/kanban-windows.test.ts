// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createNestOSKanban} from '@itookit/app-core/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import {KanbanWindowWorkbench} from '../src/kanban/windows';
import {WorkbenchWindows} from '../src/workbench/windows';
import {t} from '@itookit/common';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); document.body.replaceChildren();});
async function fixture(initialResource = '/board/b/card') {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service = createNestOSKanban({store, actor: {kind: 'human', id: 'admin'}, authorize: async () => {}, log: vi.fn()});
    const board = await service.create({id: 'b', title: 'Board', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Work'}]});
    await service.execute(board.id, {operationId: 'create', expectedRevision: board.revision, command: {type: 'create-item', item: {id: 'card', title: 'A long item title', responsibility: 'Work', acceptance: 'Done'}}});
    const editor = document.createElement('main'), sidebar = document.createElement('aside'); document.body.append(sidebar, editor);
    const registry = new WorkbenchWindows(), selected = vi.fn(), queries = vi.spyOn(service, 'queryActivity'); let workbench!: KanbanWindowWorkbench;
    workbench = new KanbanWindowWorkbench({service, sidebar, editor, initialResource, selected, openSession: vi.fn(),
        windows: {registry, id: 'kanban', isActive: () => true, navigate: path => workbench.openResource(path)}});
    closes.push(() => workbench.destroy()); await workbench.start();
    const active = () => editor.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden]) > .kanban')!;
    return {editor, sidebar, registry, workbench, active, service, selected, queries};
}
async function idle(active: () => HTMLElement) {await vi.waitFor(() => expect(active().hasAttribute('aria-busy')).toBe(false));}
it('shares real opened windows with the shell and navigates item, board and catalog through the common header', async () => {
    const f = await fixture();
    await f.workbench.openResource('/board/b/card'); expect(f.queries).toHaveBeenCalledTimes(1);
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/card']);
    expect(f.sidebar.querySelector('.vfs-window-management')).not.toBeNull();
    expect(f.active().querySelector('[data-panel] .kanban__panel-header .workbench-window-list')).not.toBeNull();
    f.active().querySelector<HTMLButtonElement>('[data-panel] [data-window-navigation=parent]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/board/b')); await idle(f.active);
    expect(f.active().querySelector('.kanban__page-header .workbench-window-list')).not.toBeNull();
    expect(f.registry.items()).toHaveLength(2);
    f.active().querySelector<HTMLButtonElement>('.kanban__page-header [data-window-navigation=parent]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/')); await idle(f.active);
    expect(f.active().querySelector<HTMLButtonElement>('[data-window-navigation=parent]')!.hidden).toBe(true);
    expect(f.registry.items()).toHaveLength(3);
    await f.registry.items().find(item => item.id === '/board/b/card')!.activate();
    expect(f.active().querySelector('[data-panel] h3')?.textContent).toBe('A long item title');
});
it('keeps filter, scroll and unsaved forms when switching windows and refuses to close unsaved work', async () => {
    const f = await fixture('/board/b');
    const boardElement = f.active(), form = boardElement.querySelector<HTMLFormElement>('[data-form=filter]')!;
    form.querySelector<HTMLInputElement>('[name=search]')!.value = 'A long';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await idle(f.active);
    const column = boardElement.querySelector<HTMLElement>('[data-column=backlog]')!; column.scrollTop = 123;
    await f.workbench.openResource('/board/b/card'); await f.workbench.openResource('/board/b');
    expect(f.active()).toBe(boardElement); expect(column.scrollTop).toBe(123);
    expect(boardElement.querySelector<HTMLInputElement>('[name=search]')!.value).toBe('A long');
    boardElement.querySelector<HTMLButtonElement>('[data-action=new-item]')!.click(); await idle(f.active);
    const title = boardElement.querySelector<HTMLInputElement>('[name=title]')!; title.value = 'Unsaved'; title.dispatchEvent(new Event('input', {bubbles: true}));
    await f.workbench.openResource('/board/b/card'); await f.workbench.openResource('/board/b');
    expect(boardElement.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Unsaved');
    expect(f.registry.items().find(item => item.id === '/board/b')!.dirty).toBe(true);
    await expect(f.registry.items().find(item => item.id === '/board/b')!.close()).rejects.toThrow(t('kanban.unsaved'));
    boardElement.querySelector<HTMLButtonElement>('[data-panel] .kanban__panel-back')!.click(); await idle(f.active);
    await f.registry.items().find(item => item.id === '/board/b')!.close();
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/card']);
});
it('marks hidden windows dirty without querying them until activated, and unregisters all window metadata', async () => {
    const f = await fixture('/board/b'); await f.workbench.openResource('/board/b/card');
    f.workbench.setVisible(false); const query = vi.spyOn(f.service, 'queryActivity');
    f.workbench.invalidateFromEvents(); expect(query).not.toHaveBeenCalled();
    f.workbench.setVisible(true); await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1)); await idle(f.active);
    await f.workbench.destroy(); expect(f.registry.items()).toHaveLength(0);
});

it('keeps one VFS sidebar while switching and closing editors, including a dirty inspector', async () => {
    const f = await fixture('/board/b');
    const list = f.sidebar.querySelector('.vfs-node-list')!; expect(list).not.toBeNull();
    expect(f.sidebar.querySelector('.kanban__sidebar')).toBeNull(); expect(f.sidebar.textContent).toContain('Board');
    f.active().querySelector<HTMLButtonElement>('[data-action=new-item]')!.click(); await idle(f.active);
    const field = f.active().querySelector<HTMLInputElement>('[name=title]')!; field.value = 'Draft'; field.dispatchEvent(new Event('input', {bubbles: true}));
    expect(f.sidebar.inert).not.toBe(true);
    await f.workbench.openResource('/board/b/card'); await f.workbench.openResource('/');
    expect(f.sidebar.querySelectorAll('.vfs-node-list')).toHaveLength(1); expect(f.sidebar.querySelector('.vfs-node-list')).toBe(list);
    await f.workbench.openResource('/board/b'); expect(f.active().querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Draft');
    f.active().querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click(); await idle(f.active);
    await f.registry.items().find(item => item.id === '/board/b')!.close(); expect(f.sidebar.textContent).toContain('Board');
});
it('updates shared navigation after creating a board through its toolbar', async () => {
    const f = await fixture('/');
    f.sidebar.querySelector<HTMLButtonElement>('button[aria-label="' + t('kanban.newBoard') + '"]')!.click();
    await vi.waitFor(() => expect(f.active().querySelector('[data-form=board]')).not.toBeNull()); await idle(f.active);
    const input = f.active().querySelector<HTMLInputElement>('[name=title]')!; input.value = 'New board'; input.dispatchEvent(new Event('input', {bubbles: true}));
    f.active().querySelector<HTMLButtonElement>('[data-form=board] button:not([type])')!.click(); await idle(f.active);
    await vi.waitFor(() => expect(f.sidebar.textContent).toContain('New board'));
    expect(f.sidebar.querySelectorAll('.vfs-node-list')).toHaveLength(1); expect(f.sidebar.textContent).toContain('Board');
});

it('keeps search, create and refresh in the shared browser header without a reference lookup', async () => {
    const f = await fixture('/');
    const search = f.sidebar.querySelector<HTMLInputElement>('input[type=search]')!;
    const create = f.sidebar.querySelector<HTMLButtonElement>('button[aria-label="' + t('kanban.newBoard') + '"]')!;
    const refresh = f.sidebar.querySelector<HTMLButtonElement>('button[aria-label="' + t('kanban.refresh') + '"]')!;
    expect(search.closest('.vfs-node-list__header')?.contains(create)).toBe(true);
    expect(search.closest('.vfs-node-list__header')?.contains(refresh)).toBe(true);
    expect(create.closest('details')).toBeNull(); expect(refresh.closest('details')).toBeNull();
    expect(f.sidebar.querySelector('button[aria-label="' + t('kanban.openReference') + '"]')).toBeNull();
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentDrawer } from '../src/projects/agent-drawer';
import { WorkbenchSidebar } from '../src/workbench/sidebar';
import type { ApplicationBackend } from '@itookit/app-contracts/services';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
function setup(pending?: Promise<unknown>) {
    const unsubscribe = vi.fn(), dispose = vi.fn(async () => {}), start = vi.fn(async () => {}), navigate = vi.fn(async () => {});
    let changed = () => {};
    const agents = [{id: 'writer', name: '写作', description: '整理文档'}, {id: 'coder', name: '编程', description: '分析代码'}];
    const rename = vi.fn(async (id: string, name: string) => {agents.find(agent => agent.id === id)!.name = name;});
    const remove = vi.fn(async (id: string) => {agents.splice(agents.findIndex(agent => agent.id === id), 1);});
    const subscribe = vi.fn((listener: () => void) => {changed = listener; return unsubscribe;});
    const drawers = {list: vi.fn(() => [{id: 'group', kind: 'agents', name: 'Work', paths: agents.map(agent => '/agents/custom/' + agent.id + '.agent')}]), forPath: vi.fn(), assign: vi.fn(async () => {})};
    const view = {dispose, resources: {getAgents: async () => agents, drawers, navigation: vi.fn(async () => {}), subscribe}, inventory: {remoteAgents: new Map([
        ['remote', {id: 'remote', name: 'Remote agent', description: 'Native', source: 'Server A'}],
    ])}};
    const toolboxView = vi.fn(async () => {await pending; return view;});
    const drawer = new AgentDrawer({backend: {toolboxView} as unknown as ApplicationBackend, start, navigate, rename, remove,
        resourceId: id => '/custom/' + id + '.agent'});
    document.body.append(drawer.element); cleanup.push(() => drawer.destroy());
    return {drawer, rename, remove, toolboxView, subscribe, unsubscribe, dispose, start, navigate, agents, drawers, changed: () => changed()};
}

it('loads only on expansion and filters names, descriptions and remote sources without another read', async () => {
    const f = setup(); expect(f.toolboxView).not.toHaveBeenCalled();
    f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelectorAll('[data-item-id]')).toHaveLength(3));
    const search = f.drawer.element.querySelector<HTMLInputElement>('input')!; search.focus();
    search.value = '文档'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.drawer.element.querySelectorAll('[data-item-id]')).toHaveLength(1));
    expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull();
    expect(document.activeElement).toBe(search);
    search.value = 'server a'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="remote"]')).not.toBeNull());
    f.drawer.element.querySelector<HTMLElement>('[data-item-id="remote"]')!.click();
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({target: 'toolbox', resourceId: '/agents/@remote/remote.agent'}));
    expect(f.toolboxView).toHaveBeenCalledOnce();
});

it('launches the selected local agent and reuses the existing configuration path', async () => {
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    f.drawer.element.querySelector<HTMLElement>('[data-item-id="writer"]')!.click();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledWith('writer'));
    openMenu(f.drawer, 'writer');
    document.querySelector<HTMLButtonElement>('.vfs-context-menu [data-action="configure-agent"]')!.click();
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({target: 'toolbox', resourceId: '/agents/custom/writer.agent'}));
    f.drawer.setExpanded(false); f.agents.push({id: 'later', name: 'Later', description: 'new'}); f.changed();
    expect(f.drawer.element.querySelector('[data-item-id="later"]')).toBeNull();
    f.drawer.setExpanded(true); await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="later"]')).not.toBeNull());
});

it('does not install a subscription or restore DOM after destruction races a catalog read', async () => {
    let finish!: () => void; const pending = new Promise<void>(resolve => {finish = resolve;});
    const f = setup(pending); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.toolboxView).toHaveBeenCalledOnce());
    const closing = f.drawer.destroy(); finish(); await closing;
    expect(f.subscribe).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(document.body.contains(f.drawer.element)).toBe(false);
});

it('opens the agent view only when selected and persists the selected view', () => {
    let state = {version: 1 as const, drawerCollapsed: {agents: true}, sidebarView: 'navigation'};
    const host = document.createElement('div'); document.body.append(host);
    const sidebar = new WorkbenchSidebar(host, document.createElement('div'), {load: () => state, save: value => {state = value as typeof state;}});
    cleanup.push(() => sidebar.destroy());
    const toggle = vi.fn(); sidebar.addDrawer('agents', 'Agents', document.createElement('div'), toggle);
    expect(toggle).toHaveBeenLastCalledWith(true);
    host.querySelector<HTMLButtonElement>('[data-sidebar-view="agents"]')!.click();
    expect(toggle).toHaveBeenLastCalledWith(false); expect(state.sidebarView).toBe('agents');
    expect(host.querySelector<HTMLElement>('[data-section="navigation"]')!.hidden).toBe(true);
    host.querySelector<HTMLButtonElement>('[data-sidebar-view="navigation"]')!.click();
    expect(toggle).toHaveBeenLastCalledWith(true); expect(state.sidebarView).toBe('navigation');
});


it('renames a local agent through its menu and keeps the stable identity', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false;};
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    openMenu(f.drawer, 'writer');
    expect(document.querySelector('.vfs-context-menu [data-action="configure-agent"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.vfs-context-menu [data-action="rename-agent"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.project-dialog input')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('.project-dialog input')!;
    expect(input.value).toBe('写作'); input.value = '新的名字';
    document.querySelector<HTMLFormElement>('.project-dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(f.rename).toHaveBeenCalledWith('writer', '新的名字'));
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')?.textContent).toContain('新的名字'));
    expect(f.start).not.toHaveBeenCalled();
});

it('confirms local deletion, retains the row on failure and never offers remote deletion', async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    const remove = async () => {
        openMenu(f.drawer, 'writer');
        document.querySelector<HTMLButtonElement>('.vfs-context-menu [data-action="delete-agent"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('.vfs-context-menu [data-action="delete-agent"]')).toBeNull());
    };
    openMenu(f.drawer, 'remote');
    expect(document.querySelector('.vfs-context-menu [data-action="delete-agent"]')).toBeNull();
    await remove(); expect(f.remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); f.remove.mockRejectedValueOnce(new Error('Storage unavailable'));
    await remove(); await vi.waitFor(() => expect(f.drawer.element.textContent).toContain('Storage unavailable'));
    expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull();
    await remove(); await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).toBeNull());
});

function openMenu(drawer: AgentDrawer, id: string): void {
    drawer.element.querySelector<HTMLElement>(`[data-item-id="${id}"] [data-action="item-menu"]`)!.click();
}
async function selectAgents(f: ReturnType<typeof setup>, ids: string[]): Promise<void> {
    f.drawer.element.querySelector<HTMLButtonElement>('[data-action="select-items"]')!.click();
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-action="toggle-selection"]')).not.toBeNull());
    for (const id of ids) f.drawer.element.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!.click();
}
it('selects multiple agents by touch and deletes them after one confirmation without launching', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    await selectAgents(f, ['writer', 'coder']);
    expect(f.drawer.element.querySelectorAll('input[data-action="toggle-selection"]:checked')).toHaveLength(2);
    expect(f.start).not.toHaveBeenCalled();
    f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-delete"]')!.click();
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledOnce(); expect(f.remove.mock.calls.map(call => call[0]).sort()).toEqual(['coder', 'writer']);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).toBeNull());
    expect(f.drawer.element.querySelector('[data-item-id="remote"]')).not.toBeNull();
});

it('revalidates a frozen move selection when confirming the destination', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    await selectAgents(f, ['writer', 'coder']);
    f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-move"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.project-dialog [name="drawer"]')).not.toBeNull());
    f.agents.splice(f.agents.findIndex(agent => agent.id === 'writer'), 1);
    document.querySelector<HTMLInputElement>('.project-dialog [name="drawer"]')!.value = 'Work';
    document.querySelector<HTMLFormElement>('.project-dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(document.querySelector('.project-dialog [role="alert"]')?.textContent).not.toBe(''));
    expect(f.drawers.assign).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('.project-dialog button[type="button"]')!.click();
});
it('disables mutation for a mixed remote selection and preserves selection after cancellation', async () => {
    vi.stubGlobal('confirm', () => false);
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    await selectAgents(f, ['writer', 'remote']);
    expect(f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-delete"]')!.hidden).toBe(true);
    f.drawer.element.querySelector<HTMLElement>('[data-item-id="remote"]')!.click();
    f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-delete"]')!.click();
    await vi.waitFor(() => expect(f.drawer.element.textContent).not.toContain('加载中'));
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.drawer.element.querySelector<HTMLInputElement>('[data-item-id="writer"] input[data-action="toggle-selection"]')!.checked).toBe(true);
});
it('moves only the frozen selected agents to a group through the existing drawer service', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    await selectAgents(f, ['writer', 'coder']);
    f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-move"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.project-dialog [name="drawer"]')).not.toBeNull());
    expect(document.querySelector('.project-dialog [name="kind"]')).toBeNull();
    document.querySelector<HTMLInputElement>('.project-dialog [name="drawer"]')!.value = 'Work';
    document.querySelector<HTMLFormElement>('.project-dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(f.drawers.assign).toHaveBeenCalledWith([
        {path: '/agents/custom/writer.agent', name: 'Work'}, {path: '/agents/custom/coder.agent', name: 'Work'},
    ]));
    expect(f.remove).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});

it('refreshes partial deletion failure and keeps remaining agents selected for an explicit retry', async () => {
    vi.stubGlobal('confirm', () => true);
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    const original = f.remove.getMockImplementation()!;
    f.remove.mockImplementation(async id => {if (id === 'coder') throw new Error('Storage unavailable'); await original(id);});
    await selectAgents(f, ['writer', 'coder']);
    f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-delete"]')!.click();
    await vi.waitFor(() => expect(f.drawer.element.textContent).toContain('Storage unavailable'));
    expect(f.drawer.element.querySelector('[data-item-id="writer"]')).toBeNull();
    expect(f.drawer.element.querySelector<HTMLInputElement>('[data-item-id="coder"] input[data-action="toggle-selection"]')!.checked).toBe(true);
    expect(f.remove).toHaveBeenCalledTimes(2);
});

it('does not continue a batch or restore UI after destruction during a deletion', async () => {
    vi.stubGlobal('confirm', () => true);
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-item-id="writer"]')).not.toBeNull());
    let finish!: () => void; f.remove.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
    await selectAgents(f, ['writer', 'coder']);
    f.drawer.element.querySelector<HTMLButtonElement>('.vfs-node-list__footer [data-action="bulk-delete"]')!.click();
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledOnce());
    await f.drawer.destroy(); finish(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.remove).toHaveBeenCalledOnce(); expect(f.drawer.element.isConnected).toBe(false);
});

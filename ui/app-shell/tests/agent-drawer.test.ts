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
    const view = {dispose, resources: {getAgents: async () => agents, navigation: vi.fn(async () => {}), subscribe}, inventory: {remoteAgents: new Map([
        ['remote', {id: 'remote', name: 'Remote agent', description: 'Native', source: 'Server A'}],
    ])}};
    const toolboxView = vi.fn(async () => {await pending; return view;});
    const drawer = new AgentDrawer({backend: {toolboxView} as unknown as ApplicationBackend, start, navigate, rename, remove,
        resourceId: id => '/custom/' + id + '.agent'});
    document.body.append(drawer.element); cleanup.push(() => drawer.destroy());
    return {drawer, rename, remove, toolboxView, subscribe, unsubscribe, dispose, start, navigate, agents, changed: () => changed()};
}

it('loads only on expansion and filters names, descriptions and remote sources without another read', async () => {
    const f = setup(); expect(f.toolboxView).not.toHaveBeenCalled();
    f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelectorAll('[data-agent-id]')).toHaveLength(3));
    const search = f.drawer.element.querySelector<HTMLInputElement>('input')!; search.focus();
    search.value = '文档'; search.dispatchEvent(new Event('input'));
    expect(f.drawer.element.querySelectorAll('[data-agent-id]')).toHaveLength(1);
    expect(f.drawer.element.querySelector('[data-agent-id="writer"]')).not.toBeNull();
    expect(document.activeElement).toBe(search);
    search.value = 'server a'; search.dispatchEvent(new Event('input'));
    f.drawer.element.querySelector<HTMLButtonElement>('[data-agent-id="remote"] button')!.click();
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({target: 'toolbox', resourceId: '/agents/@remote/remote.agent'}));
    expect(f.toolboxView).toHaveBeenCalledOnce();
});

it('launches the selected local agent and reuses the existing configuration path', async () => {
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-agent-id="writer"]')).not.toBeNull());
    const buttons = f.drawer.element.querySelectorAll<HTMLButtonElement>('[data-agent-id="writer"] button');
    buttons[0].click(); await vi.waitFor(() => {expect(f.start).toHaveBeenCalledWith('writer'); expect(buttons[0].disabled).toBe(false);});
    f.drawer.element.querySelector<HTMLDetailsElement>('[data-agent-id="writer"] details')!.open = true;
    buttons[1].click(); await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({target: 'toolbox', resourceId: '/agents/custom/writer.agent'}));
    f.drawer.setExpanded(false); f.agents.push({id: 'later', name: 'Later', description: 'new'}); f.changed();
    expect(f.drawer.element.querySelector('[data-agent-id="later"]')).toBeNull();
    f.drawer.setExpanded(true); await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-agent-id="later"]')).not.toBeNull());
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
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-agent-id="writer"]')).not.toBeNull());
    const row = f.drawer.element.querySelector('[data-agent-id="writer"]')!;
    expect(row.querySelector('[data-action="configure-agent"]')).not.toBeNull();
    row.querySelector<HTMLButtonElement>('[data-action="rename-agent"]')!.click();
    const input = document.querySelector<HTMLInputElement>('.project-dialog input')!;
    expect(input.value).toBe('写作'); input.value = '新的名字';
    document.querySelector<HTMLFormElement>('.project-dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(f.rename).toHaveBeenCalledWith('writer', '新的名字'));
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-agent-id="writer"]')?.textContent).toContain('新的名字'));
    expect(f.start).not.toHaveBeenCalled();
});

it('confirms local deletion, retains the row on failure and never offers remote deletion', async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    const f = setup(); f.drawer.setExpanded(true);
    await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-agent-id="writer"]')).not.toBeNull());
    const remove = () => f.drawer.element.querySelector<HTMLButtonElement>('[data-agent-id="writer"] [data-action="delete-agent"]')!.click();
    expect(f.drawer.element.querySelector('[data-agent-id="remote"] [data-action="delete-agent"]')).toBeNull();
    remove(); expect(f.remove).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.drawer.element.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.disabled).toBe(false));
    confirm.mockReturnValue(true); f.remove.mockRejectedValueOnce(new Error('Storage unavailable'));
    remove(); await vi.waitFor(() => expect(f.drawer.element.textContent).toContain('Storage unavailable'));
    expect(f.drawer.element.querySelector('[data-agent-id="writer"]')).not.toBeNull();
    await vi.waitFor(() => expect(f.drawer.element.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.disabled).toBe(false));
    remove(); await vi.waitFor(() => expect(f.drawer.element.querySelector('[data-agent-id="writer"]')).toBeNull());
});

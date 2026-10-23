// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {WorkbenchSidebar} from '../src/workbench/sidebar';
import {WorkbenchTabs} from '../src/workbench/tabs';
import {readWorkbenchSnapshot, type WorkbenchSnapshot} from '../src/workbench/state';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

function setup(saved?: WorkbenchSnapshot) {
    let state = saved;
    const host = document.createElement('aside'), opened = document.createElement('div'), resource = document.createElement('input');
    host.append(resource); document.body.append(host);
    const sidebar = new WorkbenchSidebar(host, opened, {load: () => state, save: value => {state = value;}});
    cleanup.push(() => sidebar.destroy());
    const agents = document.createElement('input'), toggle = vi.fn();
    sidebar.addDrawer('agents', 'Agents', agents, toggle);
    return {host, sidebar, agents, resource, opened, toggle, state: () => state};
}

it('switches views with roving keyboard focus while retaining both inputs and scroll positions', () => {
    const f = setup(), changed = vi.fn(); f.sidebar.setViewChanged(changed);
    const resources = f.host.querySelector<HTMLButtonElement>('[data-sidebar-view="navigation"]')!;
    const agents = f.host.querySelector<HTMLButtonElement>('[data-sidebar-view="agents"]')!;
    f.resource.value = 'notes'; f.agents.value = 'writer'; f.sidebar.navigation.scrollTop = 73;
    resources.focus(); resources.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    expect(document.activeElement).toBe(agents); expect(agents.getAttribute('aria-selected')).toBe('true');
    expect(resources.tabIndex).toBe(-1); expect(f.state()?.sidebarView).toBe('agents'); expect(changed).toHaveBeenLastCalledWith('agents');
    expect(f.host.querySelector<HTMLElement>('[data-section="navigation"]')!.hidden).toBe(true);
    expect(document.getElementById(agents.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(agents.id);
    agents.dispatchEvent(new KeyboardEvent('keydown', {key: 'Home', bubbles: true}));
    expect(document.activeElement).toBe(resources); expect(f.resource.value).toBe('notes'); expect(f.agents.value).toBe('writer');
    expect(f.sidebar.navigation.scrollTop).toBe(73); expect(f.host.contains(f.agents)).toBe(true);
    resources.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true})); expect(document.activeElement).toBe(agents);
});

it('restores the selected view and tolerates old or unavailable layout preferences', () => {
    const restored = setup(readWorkbenchSnapshot({version: 1, sidebarView: 'agents', drawerCollapsed: {agents: true}, openedCollapsed: false}));
    expect(restored.sidebar.activeView).toBe('agents'); expect(restored.toggle).toHaveBeenLastCalledWith(false);
    const legacy = setup({version: 1, navigationCollapsed: true, drawerCollapsed: {agents: false}});
    expect(legacy.sidebar.activeView).toBe('navigation'); expect(legacy.toggle).toHaveBeenLastCalledWith(true);
    const unavailable = setup({version: 1, sidebarView: 'removed-view'});
    expect(unavailable.sidebar.activeView).toBe('navigation');
});

it('opens windows from a single-view sidebar, returns the drawer to its hidden host and restores focus', async () => {
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const main = document.createElement('main'), host = document.createElement('aside'); document.body.append(host, main);
    const tabs = new WorkbenchTabs(main, {activate: async () => {}, dispose: async () => {}, empty() {}, error(error) {throw error;}});
    const sidebar = new WorkbenchSidebar(host, tabs.opened, undefined, 'Files', slot => tabs.mountWindowList(slot));
    cleanup.push(() => sidebar.destroy(), () => tabs.destroy());
    expect(host.querySelector<HTMLElement>('[role="tablist"]')!.hidden).toBe(true);
    expect(host.querySelector('[data-section="opened"]')).toBeNull(); expect(tabs.opened.parentElement!.hidden).toBe(true);
    const trigger = host.querySelector<HTMLButtonElement>('.workbench-window-list')!; trigger.click();
    const dialog = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!;
    expect(dialog.open).toBe(true); expect(dialog.contains(tabs.opened)).toBe(true);
    dialog.close();
    expect(tabs.opened.parentElement!.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
});

it.each([undefined, () => {throw new Error('Unavailable in this WebView');}])('creates accessible view identities when the native UUID method is %s', native => {
    vi.stubGlobal('crypto', {randomUUID: native});
    const f = setup(), tabs = [...f.host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(new Set(tabs.map(tab => tab.id)).size).toBe(2);
    for (const tab of tabs) expect(document.getElementById(tab.getAttribute('aria-controls')!)).not.toBeNull();
    f.sidebar.selectView('agents'); expect(f.sidebar.activeView).toBe('agents');
});

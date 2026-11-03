// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {WorkbenchTabs} from '../src/workbench/tabs';
import {WorkbenchWindows} from '../src/workbench/windows';
import {t, getLogger} from '@itookit/common';

afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks();});
function fixture() {
    const registry = new WorkbenchWindows(); let active = 'chat';
    const source = (id: string) => {
        const container = document.createElement('section'); document.body.append(container);
        const dispose = vi.fn(async () => {}), error = vi.fn();
        const navigate = vi.fn(async (target: string) => {active = id; tabs.activate(target); registry.changed();});
        const tabs = new WorkbenchTabs(container, {navigation: id, activate: async target => {tabs.activate(target);}, dispose, empty() {}, error},
            undefined, {registry, id, isActive: () => active === id, navigate});
        document.body.append(tabs.opened);
        return {container, tabs, navigate, dispose, error};
    };
    return {registry, chat: source('chat'), toolbox: source('toolbox')};
}
it('shares windows, selection and multi-term search while preserving independent IDs and editor DOM', async () => {
    const {registry, chat, toolbox} = fixture();
    const a = await chat.tabs.open('/same', 'Draft', false), b = await toolbox.tabs.open('/same', 'Connection', false);
    const input = document.createElement('textarea'); input.value = 'unsaved text'; a.panel.append(input);
    chat.tabs.location('/same', 'Project A'); toolbox.tabs.location('/same', 'Provider B');
    expect(chat.container.querySelectorAll('[role=tab]')).toHaveLength(2);
    expect(toolbox.tabs.opened.querySelectorAll('[data-opened-id]')).toHaveLength(2);
    registry.setQuery('toolbox Provider');
    expect([...chat.tabs.opened.querySelectorAll<HTMLElement>('[data-opened-id]')].filter(row => !row.hidden)).toHaveLength(1);
    chat.tabs.opened.querySelectorAll<HTMLButtonElement>('.workbench-tabs__opened-label')[1].click();
    await vi.waitFor(() => expect(toolbox.navigate).toHaveBeenCalledWith('/same'));
    expect(a.panel.querySelector('textarea')).toBe(input); expect(input.value).toBe('unsaved text'); expect(b.panel.isConnected).toBe(true);
    toolbox.tabs.pin('/same'); registry.selectAll(true); expect(registry.items().some(item => item.selected)).toBe(false);
    registry.setQuery(''); registry.selectAll(true);
    expect(registry.items().filter(item => item.selected).map(item => item.scope)).toEqual(['chat']);
    await registry.closeSelected(); expect(chat.tabs.get('/same')).toBeUndefined(); expect(toolbox.tabs.get('/same')).toBe(b);
    await chat.tabs.destroy(); await toolbox.tabs.destroy(); expect(registry.items()).toHaveLength(0);
});
it('retains a failed window when closing selected windows across workspaces', async () => {
    const {registry, chat, toolbox} = fixture();
    const a = await chat.tabs.open('a', 'Draft', false); await toolbox.tabs.open('b', 'Configuration', false);
    chat.dispose.mockRejectedValueOnce(new Error('Storage unavailable'));
    registry.selectAll(true); await expect(registry.closeSelected()).rejects.toThrow('Storage unavailable');
    expect(chat.tabs.get('a')).toBe(a); expect(a.failed).toBe(true); expect(toolbox.tabs.get('b')).toBeUndefined();
    expect(chat.tabs.opened.querySelector('.workbench-tabs__opened-label')?.textContent).toContain('Draft');
    expect(chat.container.querySelector('.workbench-tabs__state')?.getAttribute('aria-label')).toBe(t('workbench.saveFailed'));
    await chat.tabs.destroy(); await toolbox.tabs.destroy();
});
it('navigates home and to the current parent without closing windows, and hides up on the root page', async () => {
    const container = document.createElement('section'); document.body.append(container);
    const activate = vi.fn(async (id: string) => {tabs.activate(id);});
    const tabs = new WorkbenchTabs(container, {activate, dispose: async () => {}, empty() {}, error: vi.fn()});
    const header = document.createElement('div'); container.append(header);
    const release = tabs.mountWindowList(header);
    await tabs.open('/', 'Home', false); const file = await tabs.open('/notes/draft.md', 'Draft', false);
    const input = document.createElement('textarea'); input.value = 'unsaved'; file.panel.append(input);
    const up = header.querySelector<HTMLButtonElement>('[data-window-navigation=parent]')!;
    expect(up.hidden).toBe(false); up.click();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledWith('/notes'));
    tabs.activate('/notes/draft.md'); tabs.rename('/notes/draft.md', '/moved/draft.md', 'Draft'); up.click();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledWith('/moved'));
    expect(header.querySelector('[data-window-navigation=home]')).toBeNull();
    const home = tabs.opened.querySelector<HTMLButtonElement>('[data-window-navigation=home]')!;
    expect(home.parentElement?.nextElementSibling?.matches('input[type=search]')).toBe(true); home.click();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledWith('/'));
    expect(up.hidden).toBe(true); expect(file.panel.querySelector('textarea')).toBe(input); expect(input.value).toBe('unsaved');
    expect(tabs.values()).toHaveLength(2);
    release(); expect(header.children).toHaveLength(0); await tabs.destroy();
});
it('reports a parent navigation failure with a specific diagnostic and keeps the current window', async () => {
    const container = document.createElement('section'); document.body.append(container);
    const error = vi.fn(); getLogger().clear();
    const parent = vi.fn(async () => {throw Object.assign(new Error('Directory unavailable'), {code: 'ENOENT'});});
    const tabs = new WorkbenchTabs(container, {activate: async () => {}, parent, canGoUp: () => true, dispose: async () => {}, empty() {}, error});
    const tab = await tabs.open('/private/file.md', 'File', false);
    const release = tabs.mountWindowList(container);
    container.querySelector<HTMLButtonElement>('[data-window-navigation=parent]')!.click();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.objectContaining({code: 'ENOENT'})));
    expect(tabs.current).toBe(tab);
    const logs = getLogger().query({modules: ['window-navigation']});
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({data: expect.objectContaining({code: 'ENOENT', result: 'failure', operationId: expect.any(String)})})]));
    expect(JSON.stringify(logs)).not.toContain('/private');
    release(); await tabs.destroy();
});
it('shows workspace navigation in the shared window list without requiring an opened window in that workspace',async()=>{
    const activate=vi.fn(async()=>{});
    const registry=new WorkbenchWindows(()=>[{id:'kanban',title:'Kanban',active:true,activate:async()=>{}},{id:'notes',title:'Notes',active:false,activate}]);
    const container=document.createElement('section');document.body.append(container);
    const tabs=new WorkbenchTabs(container,{activate:async()=>{},dispose:async()=>{},empty(){},error:vi.fn()},undefined,
        {registry,id:'kanban',isActive:()=>true,navigate:async()=>{}});
    await tabs.open('/board','Board',false);
    const current=tabs.opened.querySelector('[data-workspace-nav=kanban]');
    expect(current?.getAttribute('aria-current')).toBe('page');
    tabs.opened.querySelector<HTMLButtonElement>('[data-workspace-nav=notes]')!.click();
    await vi.waitFor(()=>expect(activate).toHaveBeenCalledTimes(1));expect(tabs.values()).toHaveLength(1);
    await tabs.destroy();
});

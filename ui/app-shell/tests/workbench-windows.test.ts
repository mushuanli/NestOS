// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {WorkbenchTabs} from '../src/workbench/tabs';
import {WorkbenchWindows} from '../src/workbench/windows';
import {t} from '@itookit/common';

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

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installResponsiveActions } from '@itookit/ui-common';
import {t} from '@itookit/common';
import {LayoutTemplates} from '../../llm-ui-adapter/src/components/templates/LayoutTemplates';
import {EventBinder} from '../../llm-ui-adapter/src/shell/EventBinder';
import { SessionFamilyActions } from '../src/projects/SessionFamilyActions';
import { mountHistorySearch } from '../../llm-ui-adapter/src/components/history/content-search';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('moves existing actions with their handlers and disabled state, then restores focus and menu order', () => {
    const host = document.createElement('div'); document.body.append(host);
    host.innerHTML = '<div class="primary"></div><details><summary>More</summary><div class="overflow"><button>First</button><button>Second</button></div></details>';
    let width = 400, resized!: () => void;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect = disconnect; });
    const buttons = [...host.querySelectorAll('button')], clicked = vi.fn(); buttons[0].onclick = clicked;
    buttons[1].disabled = true;
    const dispose = installResponsiveActions({ container: host, toolbar: host.querySelector('.primary')!, actions: buttons, minWidth: 640, fallbackFocus: host.querySelector('summary')! });
    width = 900; resized(); buttons[0].click(); buttons[0].focus();
    expect(clicked).toHaveBeenCalledOnce(); expect(buttons[1].disabled).toBe(true);
    expect(host.querySelector('.primary')!.children).toHaveLength(2);
    width = 400; resized();
    expect(document.activeElement).toBe(host.querySelector('summary'));
    expect([...host.querySelector('.overflow')!.children]).toEqual(buttons);
    dispose(); expect(disconnect).toHaveBeenCalledOnce();
    width = 900; resized(); expect(host.querySelector('.primary')!.children).toHaveLength(0);
});

it('keeps mobile search and More visible while moving prompt and collapse actions without cloning', () => {
    const host = document.createElement('section'); host.className = 'llm-ui-workspace';
    host.innerHTML = LayoutTemplates.renderWorkspace('Chat'); document.body.append(host);
    const titlebar = host.querySelector<HTMLElement>('.llm-workspace-titlebar')!;
    let width = 390, resized!: () => void;
    vi.spyOn(titlebar, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    const search = mountHistorySearch(host.querySelector('#llm-ui-history')!, { contents: () => [], prepare: async () => {}, reveal() {} })!;
    const collapse = host.querySelector<HTMLButtonElement>('#llm-btn-collapse')!, prompts = host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!;
    const clicked = vi.fn(), binder = new EventBinder(host, { onCollapseAll: clicked });
    binder.bindTitleBarEvents(); binder.bindNavigationEvents();
    try {
        const menu = host.querySelector<HTMLDetailsElement>('.llm-workspace-titlebar__menu')!;
        expect(menu.contains(collapse)).toBe(true); expect(menu.contains(prompts)).toBe(true);
        expect(menu.contains(search.button)).toBe(false); expect(host.querySelector('.llm-workspace-titlebar__primary')!.children).toHaveLength(0);
        menu.open = true; collapse.click(); expect(clicked).toHaveBeenCalledOnce(); expect(menu.open).toBe(false);
        width = 900; resized(); expect(host.querySelector('.llm-workspace-titlebar__primary')!.contains(collapse)).toBe(true);
        expect(host.querySelector('.llm-workspace-titlebar__primary')!.contains(prompts)).toBe(true);
        collapse.disabled = true; width = 390; resized(); expect(collapse.disabled).toBe(true);
        expect(menu.contains(collapse)).toBe(true); expect(host.querySelectorAll('#llm-btn-collapse')).toHaveLength(1);
    } finally { binder.cleanup(); search.destroy(); }
});

it('places conversation metadata and organization inside the shared More menu and cleans it up', async () => {
    let manifest = { id: 'one', title: 'One', createdAt: 1000, updatedAt: 2000 };
    const sessions = { family: async () => ({ members: [manifest] }), get: vi.fn(async () => manifest) };
    const actions = { child: vi.fn(async () => {}), open: vi.fn(), remove: vi.fn(), changed: vi.fn(), showFamily: vi.fn(), report: vi.fn() };
    const abort = new AbortController(), family = new SessionFamilyActions(sessions as never, abort.signal, actions);
    const header = document.createElement('div'); header.innerHTML = LayoutTemplates.renderWorkspace('One'); document.body.append(header);
    const binder = new EventBinder(header, {mountMoreMenu: container => family.mount(container, manifest as never)}); binder.bindTitleBarEvents();
    try {
        const time = (name: string) => header.querySelector<HTMLTimeElement>(`[data-session-time="${name}"]`)!.dateTime;
        expect(time('createdAt')).toBe(new Date(1000).toISOString());
        expect(time('updatedAt')).toBe(new Date(2000).toISOString());
        const menu = header.querySelector('details')!; menu.open = true;
        manifest = { ...manifest, updatedAt: 4000 }; menu.dispatchEvent(new Event('toggle'));
        expect(sessions.get).not.toHaveBeenCalled();
        const metadata = header.querySelector<HTMLDetailsElement>('.session-family__metadata')!;
        metadata.open = true;
        await vi.waitFor(() => expect(time('updatedAt')).toBe(new Date(4000).toISOString()));
        [...menu.querySelectorAll('button')].find(button => button.textContent === t('project.newChild'))!.click();
        await vi.waitFor(() => expect(actions.child).toHaveBeenCalledWith('one'));
        expect(menu.open).toBe(false); expect(actions.report).not.toHaveBeenCalled();
        expect(menu.querySelector('.session-family__section')?.textContent).toContain(t('project.relatedSessionHint'));
        expect(header.querySelector('.session-family__toolbar')).toBeNull();
        expect(header.querySelector('.llm-workspace-titlebar__primary .session-family__section')).toBeNull();
        menu.open = true; menu.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        expect(menu.open).toBe(false);
        family.updateMetadata({...manifest, createdAt: 0, updatedAt: NaN} as never);
        for (const field of ['createdAt', 'updatedAt']) {
            const element = header.querySelector<HTMLTimeElement>(`[data-session-time="${field}"]`)!;
            expect(element.textContent).toBe(t('project.timeUnknown'));
            expect(element.hasAttribute('datetime')).toBe(false); expect(element.hasAttribute('title')).toBe(false);
        }
        const getCount = sessions.get.mock.calls.length; binder.cleanup();
        expect(header.querySelector('.session-family__section')).toBeNull();
        menu.open = true; menu.dispatchEvent(new Event('toggle'));
        metadata.open = false; metadata.open = true; metadata.dispatchEvent(new Event('toggle'));
        expect(sessions.get).toHaveBeenCalledTimes(getCount);
    } finally { binder.cleanup(); abort.abort(); }
});

it('keeps a menu metadata read failure local, preserves cached times and retries on expansion', async () => {
    const manifest = { id: 'one', title: 'One', createdAt: 1000, updatedAt: 2000 };
    const sessions = { get: vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValue({ ...manifest, updatedAt: 4000 }) };
    const actions = { child: vi.fn(async () => {}), open: vi.fn(), remove: vi.fn(), changed: vi.fn(), report: vi.fn() };
    const abort = new AbortController(), family = new SessionFamilyActions(sessions as never, abort.signal, actions);
    const host = document.createElement('div'); document.body.append(host);
    host.innerHTML = '<details><summary>More</summary><div class="content"></div></details>';
    const dispose = family.mount(host.querySelector('.content')!, manifest as never);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const menu = host.querySelector('details')!, metadata = host.querySelector<HTMLDetailsElement>('.session-family__metadata')!;
        menu.open = true; menu.dispatchEvent(new Event('toggle')); expect(sessions.get).not.toHaveBeenCalled();
        metadata.open = true;
        const status = host.querySelector<HTMLElement>('.session-family__metadata-status')!;
        await vi.waitFor(() => expect(status.hidden).toBe(false)); expect(status.textContent).toContain('Load failed');
        const time = host.querySelector<HTMLTimeElement>('[data-session-time="updatedAt"]')!;
        expect(time.dateTime).toBe(new Date(2000).toISOString()); expect(actions.report).not.toHaveBeenCalled();
        expect(menu.open).toBe(true); expect([...host.querySelectorAll('button')].every(button => !button.disabled)).toBe(true);
        metadata.open = false; metadata.open = true;
        await vi.waitFor(() => expect(time.dateTime).toBe(new Date(4000).toISOString()));
        expect(status.hidden).toBe(true); expect(status.textContent).toBe('');
    } finally { warning.mockRestore(); dispose(); abort.abort(); }
});

it('deduplicates in-flight metadata reads and discards their results after cleanup', async () => {
    let resolve!: (value: unknown) => void;
    const sessions = { get: vi.fn(() => new Promise(done => { resolve = done; })) };
    const actions = { child: vi.fn(), open: vi.fn(), remove: vi.fn(), changed: vi.fn(), report: vi.fn() };
    const abort = new AbortController(), family = new SessionFamilyActions(sessions as never, abort.signal, actions);
    const host = document.createElement('div'); document.body.append(host);
    const dispose = family.mount(host, { id: 'one', createdAt: 1000, updatedAt: 2000 } as never);
    const metadata = host.querySelector<HTMLDetailsElement>('.session-family__metadata')!;
    metadata.open = true; metadata.dispatchEvent(new Event('toggle')); metadata.dispatchEvent(new Event('toggle'));
    expect(sessions.get).toHaveBeenCalledOnce();
    const time = host.querySelector<HTMLTimeElement>('[data-session-time="updatedAt"]')!;
    dispose(); resolve({ id: 'one', createdAt: 1000, updatedAt: 4000 }); await Promise.resolve();
    expect(time.dateTime).toBe(new Date(2000).toISOString()); expect(host.children).toHaveLength(0); abort.abort();
});

it('opens a related conversation from the title bar without merging conversation histories', async () => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const parent = {id: 'parent', title: 'Parent', createdAt: 1, updatedAt: 1};
    const child = {id: 'child', title: 'Independent', parentSessionId: 'parent', createdAt: 2, updatedAt: 2};
    const sessions = {family: async () => ({root: 'parent', members: [parent, child]})};
    const actions = {open: vi.fn(async () => {}), child: vi.fn(async () => {}), remove: vi.fn(async () => {}), changed: vi.fn(async () => {}), report: vi.fn()};
    const abort = new AbortController(), family = new SessionFamilyActions(sessions as never, abort.signal, actions);
    const host = document.createElement('div'); host.innerHTML = LayoutTemplates.renderWorkspace('Parent'); document.body.append(host);
    const binder = new EventBinder(host, {mountConversationNavigation: container => family.mountNavigation(container, parent as never)});
    binder.bindTitleBarEvents();
    try {
        host.querySelector<HTMLButtonElement>('.session-family__switcher')!.click();
        await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
        expect(document.querySelector('[aria-current="true"]')?.textContent).toBe('Parent');
        [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent?.startsWith('Independent'))!.click();
        await vi.waitFor(() => expect(actions.open).toHaveBeenCalledExactlyOnceWith('child'));
        expect(actions.child).not.toHaveBeenCalled();
    } finally { binder.cleanup(); abort.abort(); }
    expect(host.querySelector('.session-family__switcher')).toBeNull();
});

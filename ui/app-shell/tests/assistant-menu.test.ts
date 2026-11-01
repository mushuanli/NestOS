import {ACTION_ICONS} from '@itookit/common';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {AssistantEvent, AssistantOverview} from '@itookit/app-contracts/services';
import {installAssistantMenu} from '../src/navigation/assistant-menu';
import {ASSISTANT_MENU_DOCUMENT, emptyAssistantState, readAssistantState, shortcutNavigation} from '../src/navigation/assistant-shortcuts';
import {requestAssistantShortcut, withAssistantShortcut} from '../src/navigation/assistant-actions';
import {shortcutEditor, updateShortcutFields, filterTargetChoices, filterSessionChoices, type AssistantChoices} from '../src/navigation/assistant-editor';
import {matchesShortcutQuery, type AssistantMenuState} from '../src/navigation/assistant-shortcuts';
const releases: Array<() => void> = [];
afterEach(() => {for (const close of releases.splice(0)) close(); document.body.replaceChildren(); vi.restoreAllMocks();});
const event = (id: string, kind: AssistantEvent['kind'] = 'completion', priority = 4): AssistantEvent => ({id, revision: 'v1', kind, source: 'sessions', title: '<img src=x onerror=alert(1)>',
    at: 1000, priority, requiresAction: kind === 'approval', target: {target: 'chat', resourceId: id}});
function setup(initial = [event('done'), event('approval', 'approval', 0), event('failed', 'failure', 2), event('older')], state: AssistantMenuState = emptyAssistantState()) {
    document.body.innerHTML = '<aside class="app-sidebar"><div class="app-sidebar__brand">NestOS</div><ul class="main-nav-list"></ul></aside>';
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const overview: AssistantOverview = {events: initial, scanners: [{id: 'scan', name: 'My scanner', workspaceId: 'team', workspaceName: 'Team'}], unavailable: []};
    const write = vi.fn(), flush = vi.fn(async () => {}), navigate = vi.fn(async () => {}), assistantOverview = vi.fn(async () => structuredClone(overview));
    let changed!: () => void; const unsubscribe = vi.fn();
    const projects = {list: async () => [{project: {id: 'project'}, name: 'Project', path: '/renamed'}], get: vi.fn(async () => ({project: {id: 'project'}, path: '/renamed'}))};
    const abort = new AbortController();
    releases.push(installAssistantMenu({backend: {assistantOverview} as never, services: {projects, kernel: {kernel: {onChanged: () => unsubscribe}},
        sessionRepository: {subscribe: (callback: () => void) => {changed = callback; return unsubscribe;}, listSummaries: async () => [{id: 'existing', title: 'Existing', folder: '/renamed', updatedAt: 1}]}} as never,
        documents: {read: async () => state, write, flush}, current: () => ({workspace: 'chat', resource: 'current', title: 'Current page'}), navigate, signal: abort.signal}));
    const open = () => document.querySelector<HTMLButtonElement>('.assistant-launcher')!.click();
    return {overview, write, flush, navigate, assistantOverview, open, changed: () => changed(), abort, projects};
}
it('shows the same count on desktop/mobile, only previews the three most important items, and leaves approvals actionable', async () => {
    const f = setup(); await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('4'));
    expect(document.querySelectorAll('.assistant-launcher')).toHaveLength(2);
    expect(document.querySelector('.app-sidebar__brand .assistant-launcher__icon')).toBeNull();
    expect(document.querySelector('.app-sidebar__brand')!.textContent).toContain('NestOS'); f.open();
    expect([...document.querySelectorAll<HTMLElement>('[data-assistant-event]')].map(item => item.dataset.assistantEvent)).toEqual(['approval', 'failed', 'done']);
    expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('[data-assistant-read="approval"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-assistant-action=all]')!.click(); expect(document.querySelectorAll('[data-assistant-event]')).toHaveLength(4);
    document.querySelector<HTMLButtonElement>('[data-assistant-event=approval]')!.click();
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({target: 'chat', resourceId: 'approval'}));
    expect(f.write).not.toHaveBeenCalled(); expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('4');
});
it('persists read receipts only for acknowledged results and retains stale items if a source temporarily fails', async () => {
    const f = setup(); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    document.querySelector<HTMLButtonElement>('[data-assistant-read=failed]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('3'));
    expect(f.write).toHaveBeenCalledWith(ASSISTANT_MENU_DOCUMENT, expect.objectContaining({seen: {failed: 'v1'}}));
    f.overview.events = []; f.overview.unavailable = ['sessions']; f.changed();
    await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('3+'); expect(document.querySelector('[role=alert]')!.textContent).toContain('保留上次结果');
});
it.each(['directory', 'newSession', 'session', 'scanner'])('adds a %s shortcut through structured choices', async kind => {
    const f = setup([]); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    document.querySelector<HTMLButtonElement>('[data-assistant-action=add]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-form]')).not.toBeNull());
    const form = document.querySelector<HTMLFormElement>('[data-assistant-form]')!;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    field('title').value = 'My shortcut'; field('kind').value = kind; field('kind').dispatchEvent(new Event('change', {bubbles: true}));
    field('project').value = 'project'; field('project').dispatchEvent(new Event('change', {bubbles: true})); field('path').value = 'docs'; field('session').value = 'existing'; field('scanner').value = JSON.stringify(['team', 'scan']);
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-shortcut]')).not.toBeNull());
    const state = f.write.mock.calls.at(-1)![1], item = state.shortcuts[0];
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/); expect(item.title).toBe('My shortcut');
    document.querySelector<HTMLButtonElement>('[data-assistant-shortcut]')!.click();
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
    const target = f.navigate.mock.calls[0][0] as {target: string; resourceId: string};
    if (kind === 'directory') expect(target.resourceId).toBe('/folder:renamed/@files/docs');
    if (kind === 'newSession') expect(target.resourceId).toBe('draft:project');
    if (kind === 'session') expect(target.resourceId).toBe('existing');
    if (kind === 'scanner') expect(target).toEqual({target: 'twin', resourceId: '/workspace/team/sources/plan%3Ascan'});
});
it('keeps the form and shortcut identity on failed persistence, then retries without duplicating the item', async () => {
    const f = setup([]); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    f.flush.mockRejectedValueOnce(new Error('storage unavailable'));
    document.querySelector<HTMLButtonElement>('[data-assistant-action=add]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-form]')).not.toBeNull());
    const form = document.querySelector<HTMLFormElement>('[data-assistant-form]')!;
    form.querySelector<HTMLInputElement>('[name=title]')!.value = 'Retained';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(form.querySelector('[data-assistant-form-error]')!.textContent).toContain('保存失败'));
    expect(form.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Retained');
    const id = f.write.mock.calls[0][1].shortcuts[0].id;
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-shortcut]')).not.toBeNull());
    expect(f.write.mock.calls.at(-1)![1].shortcuts).toHaveLength(1); expect(f.write.mock.calls.at(-1)![1].shortcuts[0].id).toBe(id);
});
it('validates relative directories and resolves project identities again after a rename', async () => {
    const f = setup([]);
    await expect(shortcutNavigation({kind: 'directory', projectId: 'project', path: 'docs'}, f.projects as never)).resolves.toEqual({target: 'chat', resourceId: '/folder:renamed/@files/docs'});
    await expect(shortcutNavigation({kind: 'directory', projectId: 'project', path: '../private'}, f.projects as never)).rejects.toThrow('ASSISTANT_SHORTCUT_INVALID');
    expect(() => readAssistantState({...emptyAssistantState(), shortcuts: [{id: 'x', title: 'Bad', target: {kind: 'resource', workspace: 'javascript:alert(1)', resource: ''}}]})).toThrow();
    f.abort.abort(); expect(document.querySelector('dialog')).toBeNull(); expect(document.querySelector('.app-sidebar__brand')!.textContent).toBe('NestOS');
});

it('shows unknown rather than zero when the initial event read fails', async () => {
    const f = setup([]); f.assistantOverview.mockRejectedValueOnce(new Error('PRIVATE_SERVER_BODY'));
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('?'));
    f.open(); expect(document.querySelector('[role=alert]')!.textContent).toContain('无法更新');
    expect(document.querySelector('[role=alert]')!.textContent).not.toContain('PRIVATE_SERVER_BODY');
});

it('filters quick access by every word across title, context and keywords without losing input focus', async () => {
    const state: AssistantMenuState = {...emptyAssistantState(), shortcuts: [
        {id: 'weekly', title: 'Weekly report', context: 'Project Alpha', keywords: '工作 周报', target: {kind: 'resource', workspace: 'notes', resource: '/report.md'}},
        {id: 'other', title: 'Weekly notes', context: 'Personal', target: {kind: 'resource', workspace: 'notes', resource: '/other.md'}},
    ]};
    const f = setup([], state); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    const search = document.querySelector<HTMLInputElement>('[data-assistant-search]')!; search.focus();
    search.value = '周报 ＡＬＰＨＡ'; search.dispatchEvent(new Event('input', {bubbles: true}));
    expect(document.querySelectorAll('[data-assistant-shortcut]')).toHaveLength(1);
    expect(document.querySelector('[data-assistant-shortcut]')!.getAttribute('data-assistant-shortcut')).toBe('weekly');
    expect(document.activeElement).toBe(search); expect(f.write).not.toHaveBeenCalled();
    f.changed(); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(document.querySelector('[data-assistant-search]'));
    search.value = ''; // The refreshed input retains the query until explicitly cleared.
    const refreshed = document.querySelector<HTMLInputElement>('[data-assistant-search]')!;
    expect(refreshed.value).toBe('周报 ＡＬＰＨＡ'); refreshed.value = 'missing'; refreshed.dispatchEvent(new Event('input', {bubbles: true}));
    expect(document.querySelector('[data-assistant-shortcut-list]')!.textContent).toContain('没有匹配项');
    refreshed.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    expect(refreshed.value).toBe(''); expect(document.querySelectorAll('[data-assistant-shortcut]')).toHaveLength(2);
    expect(matchesShortcutQuery('  alpha   REPORT ', ['Report of ALPHA'])).toBe(true);
});

it('scopes conversation choices to the exact owning project and supports multiple words in every target picker', () => {
    const choices = {projects: [{project: {id: 'parent'}, name: 'Work Alpha', path: '/work'}, {project: {id: 'child'}, name: 'Work Beta', path: '/work/child'}],
        sessions: [{id: 'one', title: 'Weekly report Alpha', folder: '/work', updatedAt: 2}, {id: 'child-session', title: 'Weekly report Beta', folder: '/work/child', updatedAt: 1}, {id: 'loose', title: 'Loose session', folder: null, updatedAt: 0}],
        scanners: [{id: 's1', name: 'Daily inbox', workspaceId: 'team', workspaceName: 'Work Alpha'}, {id: 's2', name: 'Daily calendar', workspaceId: 'personal', workspaceName: 'Personal'}]} as AssistantChoices;
    document.body.innerHTML = shortcutEditor({id: 'edit', title: 'Report', target: {kind: 'resource', workspace: 'chat', resource: 'one'}}, choices, false);
    const form = document.querySelector('form')!;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    expect(field('project').value).toBe('parent'); expect(field('session').value).toBe('one');
    expect(form.querySelector('[name=session] option[value=child-session]')).toBeNull();
    field('sessionSearch').value = 'ALPHA Weekly'; filterTargetChoices(form, choices, 'sessionSearch'); expect(field('session').value).toBe('one');
    field('project').value = 'child'; filterSessionChoices(form, choices); expect(field('session').value).toBe('');
    field('sessionSearch').value = ''; filterSessionChoices(form, choices); expect(form.querySelector('[name=session] option[value=child-session]')).not.toBeNull();
    field('project').value = '@unassigned'; filterSessionChoices(form, choices); expect(form.querySelector('[name=session] option[value=loose]')).not.toBeNull();
    field('projectSearch').value = 'Beta Work'; filterTargetChoices(form, choices, 'projectSearch'); expect(form.querySelector('[name=project] option[value=parent]')).toBeNull(); expect(form.querySelector('[name=project] option[value=child]')).not.toBeNull();
    field('scannerSearch').value = 'ALPHA inbox'; filterTargetChoices(form, choices, 'scannerSearch'); expect(form.querySelectorAll('[name=scanner] option')).toHaveLength(2);
    field('kind').value = 'directory'; updateShortcutFields(form); expect((form.querySelector('[name=project] option[value="@unassigned"]') as HTMLOptionElement).disabled).toBe(true);
});

it('adds the selected navigation target with editable keywords and reuses an existing shortcut', async () => {
    const f = setup([]); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce());
    const request = {title: 'Selected note', context: 'Notes', target: {kind: 'resource' as const, workspace: 'notes', resource: '/selected.md'}};
    const menu = withAssistantShortcut<object>(() => [{id: 'existing', label: 'Existing action'}], () => request)({}, []);
    expect(menu).toHaveLength(2); const action = menu[1]; if (action.type !== 'separator') action.onClick!({});
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-form]')).not.toBeNull());
    const form = document.querySelector<HTMLFormElement>('[data-assistant-form]')!;
    form.querySelector<HTMLInputElement>('[name=keywords]')!.value = '工作 周报'; form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    expect(f.write.mock.calls[0][1].shortcuts[0]).toMatchObject({...request, keywords: '工作 周报'});
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-form]')).toBeNull());
    requestAssistantShortcut(request); await vi.waitFor(() => expect(document.querySelector('[data-assistant-form]')).not.toBeNull());
    const again = document.querySelector<HTMLFormElement>('[data-assistant-form]')!;
    expect(again.querySelector<HTMLInputElement>('[name=keywords]')!.value).toBe('工作 周报');
    again.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(2));
    expect(f.write.mock.calls[1][1].shortcuts).toHaveLength(1);
});

it('renders actionable text instead of undefined when a loaded icon catalog lacks assistant icons', async () => {
    const icons = ACTION_ICONS as Partial<Record<'assistant' | 'markRead', string>>;
    const saved = {assistant: icons.assistant, markRead: icons.markRead};
    try {
        delete icons.assistant; delete icons.markRead;
        const f = setup([event('done')]); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
        expect(document.querySelector('.assistant-launcher__icon')!.textContent).toContain('助手');
        expect(document.querySelector('[data-assistant-read=done]')!.textContent).toBe('标为已读');
        expect(document.querySelector('.assistant-menu')!.textContent).not.toContain('undefined');
        document.querySelector<HTMLButtonElement>('[data-assistant-read=done]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('0'));
    } finally {Object.assign(icons, saved);}
});

function selectEvent(id: string, checked = true): void {
    const checkbox = document.querySelector<HTMLInputElement>(`[data-assistant-select="${id}"]`)!;
    checkbox.checked = checked; checkbox.dispatchEvent(new Event('change', {bubbles: true}));
}
it('clears multiple selected events in one write, preserving approvals and unselected events', async () => {
    const f = setup(); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    expect(document.querySelector('[data-assistant-select=approval]')).toBeNull();
    selectEvent('done'); selectEvent('failed');
    expect(document.querySelector<HTMLInputElement>('[data-assistant-select-all]')!.checked).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('2'));
    expect(f.write).toHaveBeenCalledOnce(); expect(f.flush).toHaveBeenCalledOnce();
    expect(f.write).toHaveBeenCalledWith(ASSISTANT_MENU_DOCUMENT, expect.objectContaining({seen: {done: 'v1', failed: 'v1'}}));
    expect(document.querySelector('[data-assistant-event=approval]')).not.toBeNull();
    expect(document.querySelector('[data-assistant-event=older]')).not.toBeNull(); expect(f.navigate).not.toHaveBeenCalled();
});
it('selects only visible clearable events and keeps selection when expanding the list', async () => {
    const f = setup(); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    const all = document.querySelector<HTMLInputElement>('[data-assistant-select-all]')!;
    all.checked = true; all.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector<HTMLButtonElement>('[data-assistant-action=all]')!.click();
    expect(document.querySelector<HTMLInputElement>('[data-assistant-select=older]')!.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[data-assistant-select-all]')!.indeterminate).toBe(true);
    const expanded = document.querySelector<HTMLInputElement>('[data-assistant-select-all]')!;
    expanded.checked = true; expanded.dispatchEvent(new Event('change', {bubbles: true}));
    selectEvent('done', false);
    document.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('2'));
    expect(f.write.mock.calls[0][1].seen).toEqual({failed: 'v1', older: 'v1'});
});
it('retains bulk selection on storage failure and disables duplicate submissions while saving', async () => {
    const f = setup(); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    selectEvent('done'); selectEvent('failed'); f.flush.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_BODY'));
    document.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')!.textContent).toContain('保存失败'));
    expect(document.querySelector<HTMLInputElement>('[data-assistant-select=done]')!.checked).toBe(true);
    expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('4');
    expect(document.body.textContent).not.toContain('PRIVATE_STORAGE_BODY');
    let finish!: () => void; f.flush.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
    document.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]')!.click();
    const clearing = document.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]')!;
    expect(clearing.disabled).toBe(true); clearing.click(); expect(f.flush).toHaveBeenCalledTimes(2);
    finish(); await vi.waitFor(() => expect(document.querySelector('[data-assistant-count]')!.textContent).toBe('2'));
});
it('drops a selection when refresh changes its event revision', async () => {
    const f = setup([event('done')]); await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledOnce()); f.open();
    selectEvent('done'); f.overview.events[0].revision = 'v2'; f.changed();
    await vi.waitFor(() => expect(f.assistantOverview).toHaveBeenCalledTimes(2));
    expect(document.querySelector<HTMLInputElement>('[data-assistant-select=done]')!.checked).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]')!.disabled).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectService, ProjectSearchResult } from '@itookit/app-contracts/services';
import { folderBrowserPath, projectConversationsPath } from '@itookit/app-contracts';
import { createProjectDirectorySearch } from '../src/projects/project-directory-search';
import { createDirectoryList, refreshDirectoryList } from '../src/workbench/directory-list';
const project = {path: '/P', name: 'P', project: {id: 'p'}};
const projects = {forFolder: async () => project} as unknown as ProjectService;
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it('uses source file-name search beyond loaded rows, preserves scope and restores the page when cleared', async () => {
    vi.useFakeTimers(); const open = vi.fn(async () => {});
    const search = vi.fn(async () => ({matches: [{projectId: 'p', folder: '/P', kind: 'file' as const, path: 'nested/deep/old.md', title: 'old.md', summary: '<script>needle</script>'}], truncated: false, nextCursor: null as null}));
    const path = folderBrowserPath('/P') + '/@files/nested';
    const controller = (await createProjectDirectorySearch(path, projects, {search}, open))!;
    const refresh = vi.fn(async () => [{id: 'visible', name: 'visible.md', type: 'file'}]);
    const panel = createDirectoryList({path, title: 'nested', entries: [{id: 'visible', name: 'visible.md', type: 'file'}], open: vi.fn(), refresh, search: controller}); document.body.append(panel);
    const input = panel.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'old'; input.dispatchEvent(new Event('input')); await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledWith('/P', {query: 'old', scope: 'file-name', directory: 'nested'}, expect.anything());
    expect(panel.querySelector('table')!.hidden).toBe(true); expect(panel.querySelector('script')).toBeNull();
    panel.querySelector<HTMLButtonElement>('.project-search__result')!.click(); expect(open).toHaveBeenCalledWith(expect.objectContaining({path: 'nested/deep/old.md'}), 'old');
    const scope = panel.querySelector('select')!; scope.value = 'file-content'; scope.dispatchEvent(new Event('change')); await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenLastCalledWith('/P', expect.objectContaining({scope: 'file-content', directory: 'nested'}), expect.anything());
    await refreshDirectoryList(panel); await vi.advanceTimersByTimeAsync(300); expect(refresh).toHaveBeenCalledOnce(); expect(search).toHaveBeenCalledTimes(3);
    input.value = ''; input.dispatchEvent(new Event('input')); expect(panel.querySelector('table')!.hidden).toBe(false); expect(panel.querySelector('.project-search__result')).toBeNull();
    controller.destroy();
});
it('defaults every conversation page to session names and supports prompts without a paging cursor', async () => {
    vi.useFakeTimers(); let resolve!: (result: ProjectSearchResult) => void;
    const search = vi.fn(() => new Promise<ProjectSearchResult>(done => {resolve = done;}));
    const path = projectConversationsPath('/P', {cursor: 'another-page'});
    const controller = (await createProjectDirectorySearch(path, projects, {search}, vi.fn()))!;
    controller.setQuery('older'); await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenLastCalledWith('/P', {query: 'older', scope: 'session-title', archived: false}, expect.anything());
    const scope = controller.element.querySelector('select')!; scope.value = 'session-prompt'; scope.dispatchEvent(new Event('change')); await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenLastCalledWith('/P', expect.objectContaining({scope: 'session-prompt'}), expect.anything());
    const signal = search.mock.calls.at(-1) as unknown as [string, unknown, {signal: AbortSignal}];
    controller.destroy(); expect(signal[2].signal.aborted).toBe(true);
    resolve({matches: [{kind: 'session', projectId: 'p', folder: '/P', title: 'late result', summary: 'late'}], truncated: false, nextCursor: null});
    await vi.advanceTimersByTimeAsync(0); expect(controller.element.textContent).not.toContain('late result');
});

it('keeps query, scope and clear in order and exits focused search while aborting pending reads', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const search = vi.fn(async (_folder, _query, options) => { signal = options.signal; return new Promise<ProjectSearchResult>(() => {}); });
    const controller = (await createProjectDirectorySearch(projectConversationsPath('/P'), projects, {search}, vi.fn()))!;
    const panel = createDirectoryList({path: '/P', title: 'P', entries: [{id: 'visible', name: 'Visible', type: 'session'}], open() {},
        actions: [{label: 'Create', icon: '<svg></svg>', run() {}}], search: controller}); document.body.append(panel);
    const group = panel.querySelector<HTMLElement>('.workbench-directory__search')!, toolbar = group.parentElement!;
    const input = group.querySelector<HTMLInputElement>('input[type=search]')!, scope = group.querySelector('select')!, clear = group.querySelector<HTMLButtonElement>('[data-action="clear-search"]')!;
    expect(input.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scope.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controller.element.querySelector('select')).toBeNull(); expect(controller.element.hidden).toBe(true);
    const scopeMenu = scope.closest('details')!; expect(scopeMenu.open).toBe(false);
    scopeMenu.querySelector('summary')!.click(); expect(scopeMenu.open).toBe(true);
    scope.value = 'session-content'; scope.dispatchEvent(new Event('change', {bubbles: true})); expect(scopeMenu.open).toBe(false);
    expect(document.activeElement).toBe(input);
    input.focus(); expect(toolbar.dataset.searching).toBe('true');
    input.value = 'pending'; input.dispatchEvent(new Event('input')); await vi.advanceTimersByTimeAsync(300);
    expect(panel.querySelector('table')!.hidden).toBe(true);
    scopeMenu.open = true; scopeMenu.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(scopeMenu.open).toBe(false); expect(input.value).toBe('pending'); clear.click();
    expect(signal?.aborted).toBe(true); expect(input.value).toBe(''); expect(controller.element.hidden).toBe(true); expect(group.contains(scope)).toBe(true); expect(toolbar.dataset.searching).toBe('false'); expect(panel.querySelector('table')!.hidden).toBe(false);
    controller.destroy();
});

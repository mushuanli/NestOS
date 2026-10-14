// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectSearch, ProjectSearchResult } from '@itookit/app-core';
import { ProjectSearchPanel } from '../src/projects/project-search-panel';
import { t } from '@itookit/common';
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it('discards stale responses, cancels project changes and uses structured result navigation', async () => {
    vi.useFakeTimers(); const resolvers: Array<(result: ProjectSearchResult) => void> = [];
    const search = vi.fn(() => new Promise<ProjectSearchResult>(resolve => { resolvers.push(resolve); }));
    const open = vi.fn(async () => {}), panel = new ProjectSearchPanel({search} as unknown as ProjectSearch, open);
    document.body.append(panel.element); panel.project('/P'); panel.element.querySelector('select')!.value = 'file-content';
    panel.setQuery('old'); await vi.advanceTimersByTimeAsync(300);
    panel.setQuery('new'); await vi.advanceTimersByTimeAsync(300);
    resolvers[0]({matches: [{projectId: 'p', folder: '/P', kind: 'file', path: 'old', title: 'old', summary: 'obsolete'}], truncated: false, nextCursor: null});
    await vi.advanceTimersByTimeAsync(0); expect(panel.element.textContent).not.toContain('obsolete');
    const row = {projectId: 'p', folder: '/P', kind: 'file' as const, path: 'nested/file', line: 42, title: 'file', summary: '<script>text</script>'};
    resolvers[1]({matches: [row], truncated: true, nextCursor: null}); await vi.advanceTimersByTimeAsync(0);
    expect(panel.element.querySelector('script')).toBeNull(); expect(panel.element.textContent).toContain(t('project.search.partial', {count: 1}));
    panel.element.querySelector<HTMLButtonElement>('.project-search__result')!.click(); expect(open).toHaveBeenCalledWith(row, 'new');
    panel.project('/Other'); expect(panel.element.querySelector('.project-search__result')).toBeNull(); panel.destroy();
});

it('shares the tree query and only exposes project options during a search', async () => {
    vi.useFakeTimers(); const search = vi.fn(async () => ({matches: [], truncated: false, nextCursor: null}));
    const panel = new ProjectSearchPanel({search} as unknown as ProjectSearch, vi.fn());
    panel.project('/P'); expect(panel.element.hidden).toBe(true);
    expect(panel.element.querySelector('input[type=search]')).toBeNull();
    panel.setQuery('find'); expect(panel.element.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(300); expect(search).not.toHaveBeenCalled();
    const scope = panel.element.querySelector('select')!; scope.value = 'session-content'; scope.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(300); expect(search).toHaveBeenCalledWith('/P', expect.objectContaining({query: 'find', scope: 'session-content'}), expect.anything());
    panel.setQuery(''); expect(panel.element.hidden).toBe(true); panel.destroy();
});

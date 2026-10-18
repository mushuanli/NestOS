import { ACTION_ICONS, getLocale } from '@itookit/common';
import { createContentSearch, type ContentSearchView, type SearchContent } from '@itookit/llm-ui';

interface SearchHistory {
    contents(): readonly SearchContent[];
    prepare(): Promise<void>;
    reveal(id: string): void;
}

/** Project the compatibility history into the independent library's search controls. */
export function mountHistorySearch(history: HTMLElement, binding: SearchHistory): ContentSearchView | undefined {
    const workspace = history.closest<HTMLElement>('.llm-ui-workspace');
    const anchor = workspace?.querySelector('.llm-workspace-titlebar__primary');
    if (!workspace || !anchor) return;
    const search = createContentSearch({ root: workspace, history, locale: getLocale(),
        getContents: () => binding.contents(), onNavigate: id => binding.reveal(id),
        onOpen: () => { void binding.prepare().catch(error => console.error('[HistorySearch] Preparing message content failed', error)); },
    });
    const label = search.button.textContent!;
    search.button.id = 'llm-btn-search'; search.button.className = 'llm-workspace-titlebar__btn';
    search.button.title = label; search.button.setAttribute('aria-label', label); search.button.innerHTML = ACTION_ICONS.search;
    anchor.before(search.button); workspace.querySelector('.llm-ui-workspace__workbench')!.before(search.element);
    return search;
}

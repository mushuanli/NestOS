import {referenceMenu} from './references';
import {kanbanReference} from '@itookit/app-contracts';
import {suggestionField} from './suggestion-field';
import {escapeHTML, escapeAttr, t, ACTION_ICONS} from '@itookit/common';
import type {KanbanBoardSummary, KanbanItem, KanbanItemPage, KanbanItemQuery, KanbanPrincipal} from '@itookit/app-contracts';

export const label = (key: string) => t(`kanban.${key}` as Parameters<typeof t>[0]);
export const states: KanbanItem['status'][] = ['proposed', 'backlog', 'open', 'claimed', 'review', 'completed', 'cancelled'];
export const button = (action: string, key: string, primary = false) => `<button type="button"${primary ? ' class="kanban__primary"' : ''} data-action="${escapeAttr(action)}">${escapeHTML(label(key))}</button>`;
export function contextTabs(active = 'board'): string {
    return `<nav class="kanban__context-tabs" aria-label="${escapeAttr(label('recordContext'))}">${[['board', 'tabBoard'], ['log', 'tabLog'], ['decision', 'tabDecision']].map(([value, key]) =>
        `<button type="button" data-context="${value}" ${active === value ? 'aria-current="page"' : ''}>${escapeHTML(label(key))}</button>`).join('')}</nav>`;
}
export function field(name: string, key: string, value = '', required = true, type = 'text'): string {
    return `<label>${escapeHTML(label(key))}<input name="${name}" type="${type}" value="${escapeAttr(value)}" ${required ? 'required' : ''}></label>`;
}
export function textarea(name: string, key: string, value = ''): string {
    return `<label>${escapeHTML(label(key))}<textarea name="${name}" required>${escapeHTML(value)}</textarea></label>`;
}
export function owns(item: KanbanItem, actor?: KanbanPrincipal): boolean {
    return !!actor && item.owner?.kind === actor.kind && item.owner.id === actor.id;
}
export function navigation(boards: KanbanBoardSummary[], selected: string): string {
    return `<header class="kanban__sidebar-header"><h2>${escapeHTML(label('title'))}</h2>${button('new-board', 'createShort')}</header>
        <section class="kanban__board-list"><p class="kanban__caption">${escapeHTML(label('scope'))}</p><nav aria-label="${escapeAttr(label('title'))}">${boards.map(board =>
            `<button type="button" data-board="${escapeAttr(board.id)}" ${board.id === selected ? 'aria-current="page"' : ''}><small>${escapeHTML(kanbanReference(board))}</small><span>${escapeHTML(board.title)}</span></button>`).join('')}</nav></section>
        <footer class="kanban__sidebar-tools"><details class="kanban__reference-lookup"><summary>${escapeHTML(label('openReference'))}</summary><form data-form="reference"><input name="reference" aria-label="${escapeAttr(label('reference'))}" placeholder="${escapeAttr(label('referencePlaceholder'))}" required><button>${escapeHTML(label('openShort'))}</button></form></details>
        <details class="kanban__scope-note"><summary>${escapeHTML(label('scopeInfo'))}</summary><p>${escapeHTML(label('scopeHelp'))}</p></details></footer>`;
}
export function boardHeader(board: KanbanBoardSummary, active = 'board'): string {
    const [action, key] = active === 'log' ? ['new-log', 'newLog'] : active === 'decision' ? ['new-decision', 'newDecision'] : ['new-item', 'newItem'];
    return `<header class="kanban__page-header"><div class="kanban__board-heading"><code title="${escapeAttr(kanbanReference(board))}">${escapeHTML(kanbanReference(board))}</code><h2>${escapeHTML(board.title)}</h2></div>
        <div class="kanban__header-actions">${button(action, key, true)}<button type="button" class="kanban__icon-button" data-action="refresh" aria-label="${escapeAttr(label('refresh'))}" title="${escapeAttr(label('refresh'))}">${ACTION_ICONS.refreshView}</button>${referenceMenu(board)}</div></header>`;
}
export function boardView(board: KanbanBoardSummary, page: KanbanItemPage, query: KanbanItemQuery): string {
    const columns = query.view === 'archive' ? [{id: 'archive', label: label('archive'), states}] : board.columns ?? states.map(state => ({id: state, label: label(state), states: [state]}));
    return `${boardHeader(board)}${contextTabs()}<form data-form="filter" class="kanban__filters"><input name="search" aria-label="${escapeAttr(label('search'))}" placeholder="${escapeAttr(label('search'))}" value="${escapeAttr(query.search ?? '')}">
        <select name="view" aria-label="${escapeAttr(label('filter'))}">${['all', 'backlog', 'ready', 'in-progress', 'review', 'closed', 'proposed', 'archive'].map(view => `<option value="${view}" ${view === query.view ? 'selected' : ''}>${escapeHTML(label(view === 'ready' ? 'open' : view === 'in-progress' ? 'claimed' : view === 'closed' ? 'completed' : view))}</option>`).join('')}</select>
        <details class="kanban__filter-more" data-popover><summary>${escapeHTML(label('moreFilters'))}${query.area || query.milestone ? '<span class="kanban__filter-dot" aria-hidden="true"></span>' : ''}</summary><div class="kanban__filter-fields">${suggestionField({name: 'area', label: 'area', kind: 'area', free: true, selected: query.area ? [{id: query.area, label: query.area}] : []})}
        ${suggestionField({name: 'milestone', label: 'milestone', kind: 'milestone', free: true, selected: query.milestone ? [{id: query.milestone, label: query.milestone}] : []})}</div></details><button>${escapeHTML(label('filter'))}</button></form>
        <p class="kanban__count" role="status">${escapeHTML(t('kanban.total', {count: page.total}))}</p><div class="kanban__columns" data-has-items="${page.items.length > 0}">${columns.map(column => {
            const items = page.items.filter(item => column.states.includes(item.status));
            return `<section class="kanban__column" data-empty="${items.length === 0}"><h3>${escapeHTML(column.label)} <small>${items.length}</small></h3><div class="kanban__column-items" data-column="${escapeAttr(column.id)}" tabindex="0" aria-label="${escapeAttr(column.label + ' · ' + label('columnItems'))}">${items.map(item => `<button type="button" class="kanban__card" data-item="${escapeAttr(item.id)}"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(kanbanReference(board, item))}</small><small>P${item.planning.priority} · ${escapeHTML(item.planning.area ?? '')} · ${escapeHTML(item.planning.milestone ?? '')}</small>${item.pendingAmendments ? `<small class="kanban__badge">${escapeHTML(label('pendingAmendments'))} (${item.pendingAmendments})</small>` : ''}${item.progress ? `<small>${item.progress.completed}/${item.progress.total}</small>` : ''}</button>`).join('') || `<p>${escapeHTML(label('emptyItems'))}</p>`}</div></section>`;
        }).join('')}</div><footer class="kanban__toolbar"><small>${escapeHTML(label('scrollHint'))}</small>${button('scroll-left', 'previousColumns')}${button('scroll-right', 'nextColumns')}${query.cursor ? button('first', 'first') : ''}${page.nextCursor ? button('next', 'next') : ''}</footer>`;
}

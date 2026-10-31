import {escapeAttr, escapeHTML, t, CHAT_ICONS} from '@itookit/common';
import {kanbanReference, type KanbanBoardSummary} from '@itookit/app-contracts';

export function referenceView(board: KanbanBoardSummary, entity?: {id: string; number?: number; kind?: 'log' | 'decision'}): string {
    return `<div class="kanban__reference"><code>${escapeHTML(kanbanReference(board, entity))}</code>${referenceMenu(board, entity)}</div>`;
}
export function referenceMenu(board: KanbanBoardSummary, entity?: {id: string; number?: number; kind?: 'log' | 'decision'}): string {
    const reference = kanbanReference(board, entity);
    const path = `/board/${encodeURIComponent(board.id)}${entity ? entity.kind ? '/@record/' + encodeURIComponent(entity.id) : '/' + encodeURIComponent(entity.id) : ''}`;
    return `<details class="kanban__menu" data-popover><summary aria-label="${escapeAttr(t('kanban.referenceActions'))}" title="${escapeAttr(t('kanban.referenceActions'))}">${CHAT_ICONS.more}</summary>
        <div class="kanban__menu-content"><button type="button" data-action="copy-reference" data-copy="${escapeAttr(reference)}">${escapeHTML(t('kanban.copyReference'))}</button>
        <button type="button" data-action="copy-link" data-copy="${escapeAttr(path)}">${escapeHTML(t('kanban.copyLink'))}</button></div></details>`;
}
export async function copyReference(button: HTMLElement): Promise<void> {
    const value = button.dataset.copy ?? '';
    const text = button.dataset.action === 'copy-link' ? `${location.href.split('#')[0]}#/kanban/${encodeURIComponent(value)}` : value;
    try {await navigator.clipboard.writeText(text); button.textContent = t('kanban.copied');}
    catch {throw Object.assign(new Error(t('kanban.copyFailed')), {code:'COPY_FAILED'});}
}

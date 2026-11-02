import {DEFAULT_KANBAN_WORK_TYPES, type KanbanBoardSummary, type KanbanItem, type KanbanItemPage} from '../contracts';
import type {KanbanPresentation} from './ports';
import {escapeAttr, escapeHTML} from './html';
import {button} from './view';

export function childType(board: KanbanBoardSummary, parent: KanbanItem): string | undefined {
    const types = board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;
    const rank = types.find(type => type.id === (parent.planning?.kind ?? board.defaultWorkType ?? 'task'))?.rank;
    const candidates = types.filter(type => rank !== undefined && type.rank > rank);
    return (candidates.find(type => type.id === (board.defaultWorkType ?? 'task')) ?? candidates.sort((a, b) => a.rank - b.rank)[0])?.id;
}
export function childrenView(ui: KanbanPresentation, page: KanbanItemPage, cursor: string | undefined, canCreate: boolean): string {
    return `<h4>${escapeHTML(ui.text('children'))} (${page.total})</h4><div class="kanban__actions">${canCreate ? button(ui, 'new-child', 'newChild') : ''}</div>
        <div class="kanban__record-list">${page.items.map(item => `<button type="button" class="kanban__card" data-item="${escapeAttr(item.id)}"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(ui.text(item.status))}</small></button>`).join('')}</div>
        <div class="kanban__actions">${cursor ? button(ui, 'children-first', 'first') : ''}${page.nextCursor ? `<button type="button" data-action="children-next" data-cursor="${escapeAttr(page.nextCursor)}">${escapeHTML(ui.text('next'))}</button>` : ''}</div>`;
}

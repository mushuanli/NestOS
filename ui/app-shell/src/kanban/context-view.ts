import {referenceView} from './references';
import {kanbanReference} from '@itookit/app-contracts';
import {suggestionField, selectedItems} from './suggestion-field';
import {escapeAttr, escapeHTML} from '@itookit/common';
import type {KanbanBoardSummary, KanbanItem, KanbanProjectRecord, KanbanRecordPage, KanbanSourceRef} from '@itookit/app-contracts';
import {button, field, label, textarea, contextTabs, boardHeader} from './view';
export function recordsView(page: KanbanRecordPage, kind: KanbanProjectRecord['kind'], hasPrevious: boolean, board?: KanbanBoardSummary): string {
    return `${board ? boardHeader(board, kind) : `<header class="kanban__toolbar"><h2>${escapeHTML(label(kind))}</h2></header>`}
        ${contextTabs(kind)}<p>${escapeHTML(label('recordHelp'))}</p><div class="kanban__record-list" tabindex="0" aria-label="${escapeAttr(label(kind))}">${recordLinks(page, board)}${!page.total ? `<p>${escapeHTML(label('emptyRecords'))}</p>` : ''}</div>
        <footer class="kanban__toolbar">${hasPrevious ? button('records-first', 'first') : ''}${page.nextCursor ? button('records-next', 'next') : ''}</footer>`;
}
export function recordLinks(page: KanbanRecordPage, board?: KanbanBoardSummary): string {
    return page.items.map(record => `<button type="button" class="kanban__card" data-record="${escapeAttr(record.id)}"><strong>${escapeHTML(record.title)}</strong>${board ? `<small>${escapeHTML(kanbanReference(board, record))}</small>` : ''}<small>${escapeHTML(label(record.kind))} · ${escapeHTML(label(record.status))} · ${escapeHTML(new Date(record.createdAt).toLocaleString())}</small></button>`).join('');
}
export function sourcesView(sources: KanbanSourceRef[]): string {
    return sources.length ? `<ul>${sources.map(source => `<li><button type="button" data-session="${escapeAttr(source.sessionId)}">${escapeHTML(source.sessionId)}</button><small>${escapeHTML(source.messageId)} · ${escapeHTML(source.revision)} · ${escapeHTML(source.role)}</small></li>`).join('')}</ul>` : `<p>${escapeHTML(label('noSources'))}</p>`;
}
export function recordForm(kind: KanbanProjectRecord['kind'], board: KanbanBoardSummary, itemId = ''): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(label(kind === 'log' ? 'newLog' : 'newDecision'))}</h3>${button('close-panel', 'close')}</header><form data-form="record">
        <input type="hidden" name="kind" value="${kind}">${field('title', 'name')}${textarea('content', 'content')}${kind === 'decision' ? textarea('rationale', 'rationale') + suggestionField({name: 'supersedes', label: 'supersedes', kind: 'decision'}) : ''}
        ${itemChoices(board, itemId)}<details><summary>${escapeHTML(label('sources'))}</summary>${suggestionField({name: 'sourceSession', label: 'sourceSession', kind: 'session', manual: true})}${field('sourceMessage', 'sourceMessage', '', false)}${field('sourceRevision', 'sourceRevision', '', false)}</details><button>${escapeHTML(label('save'))}</button></form>`;
}
export function recordDetail(record: KanbanProjectRecord, board: KanbanBoardSummary): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(record.title)}</h3>${button('close-panel', 'close')}</header>${referenceView(board, record)}
        <p>${escapeHTML(label(record.kind))} · ${escapeHTML(label(record.status))} · ${escapeHTML(label(record.origin))}</p><small>${escapeHTML(label('recordId'))}: ${escapeHTML(record.id)}</small><p>${escapeHTML(label('author'))}: ${escapeHTML(record.author.id)} · ${escapeHTML(new Date(record.createdAt).toLocaleString())}</p>
        <section class="kanban__prose"><h4>${escapeHTML(label('content'))}</h4><p>${escapeHTML(record.content)}</p>${record.rationale ? `<h4>${escapeHTML(label('rationale'))}</h4><p>${escapeHTML(record.rationale)}</p>` : ''}</section>
        ${record.status === 'draft' ? `<div class="kanban__actions">${button('confirm-record', 'confirmRecord')}${button('reject-record', 'rejectRecord')}</div>` : ''}
        ${record.supersedes ? recordLink(record.supersedes, 'supersedes') : ''}${record.supersededBy ? recordLink(record.supersededBy, 'superseded') : ''}
        <h4>${escapeHTML(label('itemIds'))}</h4>${record.itemIds.map(id => `<button type="button" data-item="${escapeAttr(id)}">${escapeHTML(board.items.find(item => item.id === id)?.title ?? id)}</button>`).join('')}
        <form data-form="record-link">${suggestionField({name: 'itemId', label: 'itemIds', kind: 'item', required: true})}<button>${escapeHTML(label('linkRecord'))}</button></form><h4>${escapeHTML(label('sources'))}</h4>${sourcesView(record.sources)}`;
}
function recordLink(id: string, key: string): string {return `<p>${escapeHTML(label(key))}: <button type="button" data-record="${escapeAttr(id)}">${escapeHTML(id)}</button></p>`;}
export function amendmentsView(item: KanbanItem): string {
    const pending = item.amendments?.filter(proposal => proposal.status === 'pending') ?? [];
    if (!pending.length) return '';
    return `<section class="kanban__amendments"><h4>${escapeHTML(label('amendments'))}</h4><p>${escapeHTML(label('amendmentHint'))}</p>${pending.map(proposal => `<article><strong>${escapeHTML(proposal.proposedBy.id)}</strong><small> v${proposal.baseRevision}</small>
        <details><summary>${escapeHTML(label('currentText'))}</summary><p>${escapeHTML(item.title)}</p><p>${escapeHTML(item.responsibility)}</p><p>${escapeHTML(item.acceptance)}</p></details>
        <h5>${escapeHTML(label('proposedText'))}</h5><p>${escapeHTML(proposal.proposed.title)}</p><p>${escapeHTML(proposal.proposed.responsibility)}</p><p>${escapeHTML(proposal.proposed.acceptance)}</p>
        ${sourcesView(proposal.sources)}<form data-form="amendment" data-amendment="${escapeAttr(proposal.id)}"><select name="decision" aria-label="${escapeAttr(label('amendments'))}"><option value="accept">${escapeHTML(label('applyAmendment'))}</option><option value="reject">${escapeHTML(label('rejectAmendment'))}</option></select>${field('reason', 'reason', '', false)}<button>${escapeHTML(label('save'))}</button></form></article>`).join('')}</section>`;
}

function itemChoices(board: KanbanBoardSummary, itemId: string): string {
    return suggestionField({name: 'itemIds', label: 'itemIds', kind: 'item', multiple: true, selected: selectedItems(board, itemId ? [itemId] : [])});
}

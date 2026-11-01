import type {KanbanPresentation} from './ports';
import {referenceView} from './references';
import {suggestionField, selectedItems} from './suggestion-field';
import {amendmentsView, sourcesView} from './context-view';
import {escapeHTML, escapeAttr} from './html';
import type {KanbanBoardSummary, KanbanEvent, KanbanItem, KanbanPrincipal} from '../contracts';
import {button, field, textarea, owns} from './view';

export function newBoardForm(ui: KanbanPresentation): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(ui.text('newBoard'))}</h3>${button(ui, 'close-panel', 'close')}</header><form data-form="board">${field(ui, 'title', 'boardName')}
        <label><input name="requireEstimate" type="checkbox">${escapeHTML(ui.text('requireEstimate'))}</label>
        ${save(ui)}</form>`;
}
export function newItemForm(ui: KanbanPresentation, board: KanbanBoardSummary): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(ui.text('newItem'))}</h3>${button(ui, 'close-panel', 'close')}</header><form data-form="item">${field(ui, 'title', 'name')}
        ${textarea(ui, 'responsibility', 'responsibility')}${textarea(ui, 'acceptance', 'acceptance')}${planningFields(ui, board)}${save(ui)}</form>`;
}
function planningFields(ui: KanbanPresentation, board: KanbanBoardSummary, item?: KanbanItem): string {
    const plan = item?.planning, types = board.workTypes ?? [{id: 'initiative', label: ui.text('goal')}, {id: 'feature', label: ui.text('group')}, {id: 'task', label: ui.text('action')}];
    return `<label>${escapeHTML(ui.text('type'))}<select name="kind">${types.map(type => `<option value="${escapeAttr(type.id)}" ${type.id === (plan?.kind ?? board.defaultWorkType ?? 'task') ? 'selected' : ''}>${escapeHTML(type.label)}</option>`).join('')}</select></label>
        ${field(ui, 'priority', 'priority', String(plan?.priority ?? 2), true, 'number')}
        ${suggestionField({name: 'area', label: 'area', kind: 'area', free: true, selected: plan?.area ? [{id: plan.area, label: plan.area}] : []})}${suggestionField({name: 'milestone', label: 'milestone', kind: 'milestone', free: true, selected: plan?.milestone ? [{id: plan.milestone, label: plan.milestone}] : []})}
        ${suggestionField({name: 'parentId', label: 'parent', kind: 'parent', excludeItemId: item?.id, selected: selectedItems(board, plan?.parentId ? [plan.parentId] : [])})}${suggestionField({name: 'dependencies', label: 'dependencies', kind: 'dependency', multiple: true, excludeItemId: item?.id, selected: selectedItems(board, plan?.dependencies ?? [])})}
        ${field(ui, 'dueAt', 'dueAt', dateInput(plan?.dueAt), false, 'datetime-local')}`;
}
function dateInput(at?: number): string {
    if (at === undefined) return '';
    const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const save = (ui: KanbanPresentation) => `<div class="kanban__actions"><button>${escapeHTML(ui.text('save'))}</button>${button(ui, 'close-panel', 'close')}</div>`;
export function detailView(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, actor: KanbanPrincipal | undefined, archived: boolean, events: KanbanEvent[]): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(item.title)}</h3>${button(ui, 'close-panel', 'close')}</header>${referenceView(ui, board, item)}
        <p>${escapeHTML(ui.text('origin'))}: ${escapeHTML(item.origin ? ui.text(item.origin.kind === 'discovery' ? 'flow' : 'manual') + ' · ' + item.origin.principal.id : ui.text('unknownOrigin'))}</p>
        <dl><dt>${escapeHTML(ui.text('itemId'))}</dt><dd>${escapeHTML(item.id)}</dd><dt>${escapeHTML(ui.text('responsibility'))}</dt><dd>${escapeHTML(item.responsibility)}</dd>
        <dt>${escapeHTML(ui.text('acceptance'))}</dt><dd>${escapeHTML(item.acceptance)}</dd><dt>${escapeHTML(ui.text('owner'))}</dt><dd>${escapeHTML(item.owner?.id ?? item.owner?.agentId ?? ui.text('none'))}</dd></dl>
        <p>${escapeHTML(ui.text(item.status))}${item.blocked ? ' · ' + escapeHTML(ui.text('blocked') + ': ' + item.blocked.reason) : ''}</p>
        <div class="kanban__actions">${controls(ui, board, item, actor, archived)}</div>
        ${amendmentsView(ui, item)}
        ${archived ? '' : detailForms(ui, board, item, actor)}
        <section data-related-records></section><h4>${escapeHTML(ui.text('sources'))}</h4>${sourcesView(ui, item.sources ?? [])}
        <div data-execution-session></div>
        <h4>${escapeHTML(ui.text('sessions'))}</h4>${item.participants.map(p => `<button type="button" data-session="${escapeAttr(p.sessionId)}">${escapeHTML(p.sessionId)} · ${escapeHTML(p.roles.join(', '))}</button>`).join('') || `<p>${escapeHTML(ui.text('none'))}</p>`}
        ${archived ? '' : `<form data-form="session">${suggestionField({name: 'sessionId', label: 'session', kind: 'session', manual: true, required: true})}<button>${escapeHTML(ui.text('registerSession'))}</button></form>`}
        <details><summary>${escapeHTML(ui.text('eventsHelp'))}</summary><ol>${events.map(event => `<li>${escapeHTML(event.kind)} · ${escapeHTML(event.actor.id ?? event.actor.agentId ?? '')} · ${escapeHTML(new Date(event.at).toLocaleString())}${event.data.message ? `<p>${escapeHTML(event.data.message)}</p>` : ''}</li>`).join('')}</ol></details>`;
}
function controls(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, actor: KanbanPrincipal | undefined, archived: boolean): string {
    if (archived) return button(ui, 'restore', 'restore');
    if (['completed', 'cancelled'].includes(item.status)) return button(ui, 'archive', 'archiveItem');
    const executable = board.workTypes?.find(type => type.id === item.planning?.kind)?.executable ?? item.planning?.kind === 'task';
    let result = item.status === 'proposed' ? button(ui, 'publish', 'publish') : item.status === 'backlog' && executable ? button(ui, 'ready', 'ready') : item.status === 'open' ? button(ui, 'defer', 'defer') : '';
    if (owns(item, actor) && item.status === 'claimed') result += button(ui, 'renew', 'renew');
    if (item.status === 'review' && !owns(item, actor)) result += button(ui, 'accept', 'accept') + button(ui, 'reject', 'reject');
    if (item.blocked) result += button(ui, 'unblock', 'unblock');
    if (item.status === 'review' && owns(item, actor) && board.policy.review !== 'assignee') result += `<p>${escapeHTML(ui.text('noReview'))}</p>`;
    return result;
}
function detailForms(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, actor?: KanbanPrincipal): string {
    if (['completed', 'cancelled'].includes(item.status)) return '';
    let forms = '';
    const executable = board.workTypes?.find(type => type.id === item.planning?.kind)?.executable ?? item.planning?.kind === 'task';
    if (!executable && ['backlog', 'proposed', 'open'].includes(item.status)) forms += `<form data-form="close-plan">${field(ui, 'resultRef', 'result')}<button>${escapeHTML(ui.text('closePlan'))}</button></form>`;
    if (executable && item.status === 'open' && !item.blocked) forms += `<form data-form="claim">${board.policy.requireEstimate !== false ? estimates(ui) : ''}<button>${escapeHTML(ui.text('claim'))}</button></form>`;
    if (item.status === 'claimed' && owns(item, actor)) forms += `<form data-form="submit">${field(ui, 'resultRef', 'result')}<button>${escapeHTML(ui.text('submit'))}</button></form>`;
    let secondary = '';
    if (['proposed', 'backlog', 'open'].includes(item.status)) secondary += `<details><summary>${escapeHTML(ui.text('plan'))}</summary><form data-form="plan">${planningFields(ui, board, item)}<button>${escapeHTML(ui.text('save'))}</button></form></details><form data-form="cancel">${field(ui, 'reason', 'reason')}<button>${escapeHTML(ui.text('cancel'))}</button></form>`;
    if (owns(item, actor)) secondary += `<form data-form="release">${field(ui, 'reason', 'reason')}<button>${escapeHTML(ui.text('release'))}</button></form>`;
    if (!item.blocked && (!item.owner || owns(item, actor))) secondary += `<form data-form="block">${field(ui, 'reason', 'reason')}<button>${escapeHTML(ui.text('block'))}</button></form>`;
    return forms + `<details><summary>${escapeHTML(ui.text('moreActions'))}</summary>` + secondary + `<form data-form="message">${textarea(ui, 'message', 'message')}<button>${escapeHTML(ui.text('send'))}</button></form></details>`;
}
function estimates(ui: KanbanPresentation): string {
    return `${field(ui, 'complexity', 'complexity', '1', true, 'number')}${field(ui, 'workUnits', 'workUnits', '1', true, 'number')}
        ${field(ui, 'duration', 'duration', '30', true, 'number')}<label>${escapeHTML(ui.text('confidence'))}<select name="confidence">${['low', 'medium', 'high'].map(value => `<option value="${value}">${escapeHTML(ui.text(value))}</option>`).join('')}</select></label>`;
}

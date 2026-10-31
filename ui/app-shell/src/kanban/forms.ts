import {referenceView} from './references';
import {suggestionField, selectedItems} from './suggestion-field';
import {amendmentsView, sourcesView} from './context-view';
import {escapeHTML, escapeAttr} from '@itookit/common';
import type {KanbanBoardSummary, KanbanEvent, KanbanItem, KanbanPrincipal} from '@itookit/app-contracts';
import {button, field, textarea, label, owns} from './view';

export function newBoardForm(): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(label('newBoard'))}</h3>${button('close-panel', 'close')}</header><form data-form="board">${field('title', 'boardName')}
        <label><input name="requireEstimate" type="checkbox">${escapeHTML(label('requireEstimate'))}</label>
        ${save()}</form>`;
}
export function newItemForm(board: KanbanBoardSummary): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(label('newItem'))}</h3>${button('close-panel', 'close')}</header><form data-form="item">${field('title', 'name')}
        ${textarea('responsibility', 'responsibility')}${textarea('acceptance', 'acceptance')}${planningFields(board)}${save()}</form>`;
}
function planningFields(board: KanbanBoardSummary, item?: KanbanItem): string {
    const plan = item?.planning, types = board.workTypes ?? [{id: 'initiative', label: label('goal')}, {id: 'feature', label: label('group')}, {id: 'task', label: label('action')}];
    return `<label>${escapeHTML(label('type'))}<select name="kind">${types.map(type => `<option value="${escapeAttr(type.id)}" ${type.id === (plan?.kind ?? board.defaultWorkType ?? 'task') ? 'selected' : ''}>${escapeHTML(type.label)}</option>`).join('')}</select></label>
        ${field('priority', 'priority', String(plan?.priority ?? 2), true, 'number')}
        ${suggestionField({name: 'area', label: 'area', kind: 'area', free: true, selected: plan?.area ? [{id: plan.area, label: plan.area}] : []})}${suggestionField({name: 'milestone', label: 'milestone', kind: 'milestone', free: true, selected: plan?.milestone ? [{id: plan.milestone, label: plan.milestone}] : []})}
        ${suggestionField({name: 'parentId', label: 'parent', kind: 'parent', excludeItemId: item?.id, selected: selectedItems(board, plan?.parentId ? [plan.parentId] : [])})}${suggestionField({name: 'dependencies', label: 'dependencies', kind: 'dependency', multiple: true, excludeItemId: item?.id, selected: selectedItems(board, plan?.dependencies ?? [])})}
        ${field('dueAt', 'dueAt', dateInput(plan?.dueAt), false, 'datetime-local')}`;
}
function dateInput(at?: number): string {
    if (at === undefined) return '';
    const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const save = () => `<div class="kanban__actions"><button>${escapeHTML(label('save'))}</button>${button('close-panel', 'close')}</div>`;
export function detailView(board: KanbanBoardSummary, item: KanbanItem, actor: KanbanPrincipal | undefined, archived: boolean, events: KanbanEvent[]): string {
    return `<header class="kanban__panel-header"><h3>${escapeHTML(item.title)}</h3>${button('close-panel', 'close')}</header>${referenceView(board, item)}
        <p>${escapeHTML(label('origin'))}: ${escapeHTML(item.origin ? label(item.origin.kind === 'discovery' ? 'flow' : 'manual') + ' · ' + item.origin.principal.id : label('unknownOrigin'))}</p>
        <dl><dt>${escapeHTML(label('itemId'))}</dt><dd>${escapeHTML(item.id)}</dd><dt>${escapeHTML(label('responsibility'))}</dt><dd>${escapeHTML(item.responsibility)}</dd>
        <dt>${escapeHTML(label('acceptance'))}</dt><dd>${escapeHTML(item.acceptance)}</dd><dt>${escapeHTML(label('owner'))}</dt><dd>${escapeHTML(item.owner?.id ?? item.owner?.agentId ?? label('none'))}</dd></dl>
        <p>${escapeHTML(label(item.status))}${item.blocked ? ' · ' + escapeHTML(label('blocked') + ': ' + item.blocked.reason) : ''}</p>
        <div class="kanban__actions">${controls(board, item, actor, archived)}</div>
        ${amendmentsView(item)}
        ${archived ? '' : detailForms(board, item, actor)}
        <section data-related-records></section><h4>${escapeHTML(label('sources'))}</h4>${sourcesView(item.sources ?? [])}
        <h4>${escapeHTML(label('sessions'))}</h4>${item.participants.map(p => `<button type="button" data-session="${escapeAttr(p.sessionId)}">${escapeHTML(p.sessionId)} · ${escapeHTML(p.roles.join(', '))}</button>`).join('') || `<p>${escapeHTML(label('none'))}</p>`}
        ${archived ? '' : `<form data-form="session">${suggestionField({name: 'sessionId', label: 'session', kind: 'session', manual: true, required: true})}<button>${escapeHTML(label('registerSession'))}</button></form>`}
        <details><summary>${escapeHTML(label('eventsHelp'))}</summary><ol>${events.map(event => `<li>${escapeHTML(event.kind)} · ${escapeHTML(event.actor.id ?? event.actor.agentId ?? '')} · ${escapeHTML(new Date(event.at).toLocaleString())}${event.data.message ? `<p>${escapeHTML(event.data.message)}</p>` : ''}</li>`).join('')}</ol></details>`;
}
function controls(board: KanbanBoardSummary, item: KanbanItem, actor: KanbanPrincipal | undefined, archived: boolean): string {
    if (archived) return button('restore', 'restore');
    if (['completed', 'cancelled'].includes(item.status)) return button('archive', 'archiveItem');
    const executable = board.workTypes?.find(type => type.id === item.planning?.kind)?.executable ?? item.planning?.kind === 'task';
    let result = item.status === 'proposed' ? button('publish', 'publish') : item.status === 'backlog' && executable ? button('ready', 'ready') : item.status === 'open' ? button('defer', 'defer') : '';
    if (owns(item, actor) && item.status === 'claimed') result += button('renew', 'renew');
    if (item.status === 'review' && !owns(item, actor)) result += button('accept', 'accept') + button('reject', 'reject');
    if (item.blocked) result += button('unblock', 'unblock');
    if (item.status === 'review' && owns(item, actor) && board.policy.review !== 'assignee') result += `<p>${escapeHTML(label('noReview'))}</p>`;
    return result;
}
function detailForms(board: KanbanBoardSummary, item: KanbanItem, actor?: KanbanPrincipal): string {
    if (['completed', 'cancelled'].includes(item.status)) return '';
    let forms = '';
    const executable = board.workTypes?.find(type => type.id === item.planning?.kind)?.executable ?? item.planning?.kind === 'task';
    if (!executable && ['backlog', 'proposed', 'open'].includes(item.status)) forms += `<form data-form="close-plan">${field('resultRef', 'result')}<button>${escapeHTML(label('closePlan'))}</button></form>`;
    if (executable && item.status === 'open' && !item.blocked) forms += `<form data-form="claim">${board.policy.requireEstimate !== false ? estimates() : ''}<button>${escapeHTML(label('claim'))}</button></form>`;
    if (item.status === 'claimed' && owns(item, actor)) forms += `<form data-form="submit">${field('resultRef', 'result')}<button>${escapeHTML(label('submit'))}</button></form>`;
    let secondary = '';
    if (['proposed', 'backlog', 'open'].includes(item.status)) secondary += `<details><summary>${escapeHTML(label('plan'))}</summary><form data-form="plan">${planningFields(board, item)}<button>${escapeHTML(label('save'))}</button></form></details><form data-form="cancel">${field('reason', 'reason')}<button>${escapeHTML(label('cancel'))}</button></form>`;
    if (owns(item, actor)) secondary += `<form data-form="release">${field('reason', 'reason')}<button>${escapeHTML(label('release'))}</button></form>`;
    if (!item.blocked && (!item.owner || owns(item, actor))) secondary += `<form data-form="block">${field('reason', 'reason')}<button>${escapeHTML(label('block'))}</button></form>`;
    return forms + `<details><summary>${escapeHTML(label('moreActions'))}</summary>` + secondary + `<form data-form="message">${textarea('message', 'message')}<button>${escapeHTML(label('send'))}</button></form></details>`;
}
function estimates(): string {
    return `${field('complexity', 'complexity', '1', true, 'number')}${field('workUnits', 'workUnits', '1', true, 'number')}
        ${field('duration', 'duration', '30', true, 'number')}<label>${escapeHTML(label('confidence'))}<select name="confidence">${['low', 'medium', 'high'].map(value => `<option value="${value}">${escapeHTML(label(value))}</option>`).join('')}</select></label>`;
}

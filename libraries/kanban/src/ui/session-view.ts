import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';
import type {KanbanExecutionSession,KanbanExecutionSessionDetail} from '../contracts';
import {sessionLink} from './session-links';
import {suggestionField} from './suggestion-field';
export function executionBadge(ui: KanbanPresentation, session?:KanbanExecutionSession,sessionUrl?: (id:string)=>string):string {
    if(!session) return '';
    const resource=session.resourceId??session.sessionId;
    return `<span class="kanban__execution" data-execution-state="${escapeAttr(session.state)}" data-stale="${session.stale}"><span>${sessionUrl?sessionLink(ui,resource,ui.text('executionSession'),sessionUrl(resource)):escapeHTML(ui.text('executionSession'))} · ${escapeHTML(ui.text('sessionState.'+session.state))}${session.stale?' · '+escapeHTML(ui.text('activityStale')):''}</span><small>${escapeHTML(activityTime(ui, session))}</small></span>`;
}
function activityTime(ui: KanbanPresentation, session:KanbanExecutionSession):string {
    if(session.lastActivityAt===undefined) return ui.text('activityUnknown');
    const minutes=Math.max(0,Math.floor((Date.now()-session.lastActivityAt)/60000));
    return ui.text('lastActivity')+' · '+(minutes<1?ui.text('justNow'):minutes<60?ui.text('minutesAgo').replace('{count}',String(minutes)):new Date(session.lastActivityAt).toLocaleString());
}
export function executionSessionView(ui: KanbanPresentation, detail:KanbanExecutionSessionDetail,editable:boolean, sessionUrl?: (id: string) => string):string {
    const session=detail.current,resource=session?.resourceId??session?.sessionId;
    return `<section class="kanban__execution-detail"><h4>${session?sessionLink(ui,resource!,ui.text('executionSession'),sessionUrl?.(resource!)):escapeHTML(ui.text('executionSession'))}</h4><p>${escapeHTML(ui.text('executionSessionHelp'))}</p>
        ${detail.continuation ? `<button type="button" data-action="continue-execution" data-dispatch="${escapeAttr(detail.continuation.previousDispatchId)}">${escapeHTML(ui.text('continueExecution'))}</button>` : ''}
        ${session?`${executionBadge(ui, session)}${sessionLink(ui, resource!, session.title ?? session.sessionId, sessionUrl?.(resource!))}<small>${escapeHTML(session.sessionId)}</small>${session.observedAt?`<small>${escapeHTML(ui.text('observedAt'))} · ${escapeHTML(new Date(session.observedAt).toLocaleString())}</small>`:''}${session.code?`<p>${escapeHTML(ui.text('activityReadFailed'))} (${escapeHTML(session.code)})</p>`:''}`:`<p>${escapeHTML(ui.text('noExecutionSession'))}</p>`}
        ${editable?`<details><summary>${escapeHTML(ui.text(session?'changeExecutionSession':'bindExecutionSession'))}</summary><form data-form="execution-session">${suggestionField({name:'executionSession',label:'executionSession',kind:'session',manual:true,required:true})}<button>${escapeHTML(ui.text('bindExecutionSession'))}</button><p data-execution-error role="alert" hidden></p></form></details>`:''}
        ${detail.history.length>(session?1:0)?`<details><summary>${escapeHTML(ui.text('executionSessionHistory'))} (${detail.history.length})</summary><ul>${detail.history.map(binding=>`<li>${sessionLink(ui, binding.sessionId, binding.sessionId, sessionUrl?.(binding.sessionId))}${binding.current?' · '+escapeHTML(ui.text('currentExecution')):''}</li>`).join('')}</ul></details>`:''}</section>`;
}
export function executionFilter(ui: KanbanPresentation, value='all'):string {
    return `<select name="execution" aria-label="${escapeAttr(ui.text('executionFilter'))}">${['all','running','recent','active'].map(filter=>`<option value="${filter}" ${filter===value?'selected':''}>${escapeHTML(ui.text('executionFilter.'+filter))}</option>`).join('')}</select>`;
}

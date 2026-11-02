import type {KanbanAutomationCatalog, KanbanBoardSummary, KanbanAnalysisStatus} from '../contracts';
import type {KanbanPresentation} from './ports';
import {panelHeader} from './panel-header';
import {escapeHTML, escapeAttr} from './html';
import {button} from './view';

export function automationForm(ui: KanbanPresentation, board: KanbanBoardSummary, catalog: KanbanAutomationCatalog): string {
    const settings = board.automation;
    const select = (name: 'planner' | 'executor' | 'preparation', label: string) => {
        const selected = JSON.stringify(settings?.[name]), targets = [...(name === 'preparation' ? catalog.preparations ?? [] : catalog.targets)];
        if (settings?.[name] && !targets.some(entry => JSON.stringify(entry.reference) === selected))
            targets.push({reference: settings[name], label: ui.text('automationTargetUnavailable')});
        return `<label>${escapeHTML(ui.text(label))}<select name="${name}" ${name === 'preparation' ? '' : 'required'}><option value="">${escapeHTML(ui.text('automationChoose'))}</option>${targets.map(entry => {
            const value = JSON.stringify(entry.reference);
            return `<option value="${escapeAttr(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(entry.label)}</option>`;
        }).join('')}</select></label>`;
    };
    return `${panelHeader(ui, ui.text('automationTitle'))}<form data-form="automation">
        <p>${escapeHTML(ui.text('automationHelp'))}</p>
        <label><input type="checkbox" name="enabled" ${settings?.enabled ? 'checked' : ''}>${escapeHTML(ui.text('automationEnabled'))}</label>
        ${select('planner', 'automationPlanner')}${select('executor', 'automationExecutor')}${select('preparation', 'automationPreparation')}
        <label><input type="checkbox" name="autoAccept" ${settings?.autoAccept ? 'checked' : ''}>${escapeHTML(ui.text('automationAutoAccept'))}</label>
        <p>${escapeHTML(ui.text('automationReviewHelp'))}</p>
        <div class="kanban__actions"><button>${escapeHTML(ui.text('save'))}</button>${button(ui, 'close-panel', 'close')}</div></form>`;
}
export function analysisView(ui: KanbanPresentation, status: KanbanAnalysisStatus | null): string {
    if (!status) return `<p>${escapeHTML(ui.text('automationPending'))}</p>`;
    return `<section><h4>${escapeHTML(ui.text('automationAnalysis'))}</h4><p>${escapeHTML(ui.text('automationState.' + status.state))}</p>
        ${status.reason ? `<p>${escapeHTML(status.reason)}</p>` : ''}${status.code ? `<p>${escapeHTML(ui.text('errors.' + status.code))}</p>` : ''}
        ${['failed', 'clarification'].includes(status.state) ? button(ui, 'reanalyze', 'automationReanalyze') : ''}</section>`;
}

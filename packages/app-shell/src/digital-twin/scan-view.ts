import { escapeHTML, escapeAttr } from '@itookit/common';
import { TWIN_KINDS, type TwinScanPlan, type TwinDataRecord } from '@itookit/app-core';
import { button, label, sources, type TwinSnapshot } from './view';

export type TwinSourcesTab = 'sources' | 'plans' | 'runs';
export function scanPage(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>, tab: TwinSourcesTab): string {
    const tabs = `<nav class="twin__tabs" aria-label="${escapeAttr(label('sources'))}">${(['plans', 'runs', 'sources'] as const).map(id =>
        `<button type="button" data-action="scanTab" data-id="${id}" aria-current="${tab === id}">${escapeHTML(label(id === 'sources' ? 'sourceList' : id === 'plans' ? 'scanPlans' : 'scanRuns'))}</button>`).join('')}</nav>`;
    return tabs + (tab === 'sources' ? sources(snapshot, connections) : tab === 'plans' ? plans(snapshot, connections) : runs(snapshot));
}
function plans(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>): string {
    return `<p>${escapeHTML(label('scanPlanHelp'))}</p><p>${escapeHTML(label('scanHostHelp'))}</p>
        <details><summary>${escapeHTML(label('addScanPlan'))}</summary>${planForm(snapshot, connections)}</details>
        ${snapshot.scans.plans.map(plan => `<article class="twin__card"><h3>${escapeHTML(plan.data.name)}</h3>
        <p>${escapeHTML(label(`scanTrigger.${plan.data.trigger}`))} · ${escapeHTML(label(`scanMode.${plan.data.mode}`))} · ${escapeHTML(label(plan.data.enabled ? 'enabled' : 'disabled'))}</p>
        <p>${escapeHTML(plan.data.rules ? label('automaticSources') : label('legacyScanPlan'))}</p>
        <p>${escapeHTML(label('scanNextAt'))}: ${date(snapshot.scans.schedules.find(schedule => schedule.planId === plan.id)?.nextAt ?? 0, plan.data.trigger !== 'manual' && plan.data.enabled)}</p>
        ${plan.data.enabled ? button('runScanPlan', 'scanNow', plan.id) + button('pauseScanPlan', 'pauseScanPlan', plan.id) : button('enableScanPlan', 'enableScanPlan', plan.id)}
        ${button('removeScanPlan', 'removeScanPlan', plan.id)}<details><summary>${escapeHTML(label('editScanPlan'))}</summary>${planForm(snapshot, connections, plan)}</details></article>`).join('')}`;
}
function planForm(_snapshot: TwinSnapshot, _connections: Array<{ id: string; name: string }>, plan?: TwinDataRecord<TwinScanPlan>): string {
    const data = plan?.data;
    return `<form class="twin__form" data-form="scanPlan" data-id="${escapeAttr(plan?.id ?? '')}">
        ${input('name', 'scanName', data?.name ?? '')}
        ${ruleText('include', 'scanInclude', data?.rules?.include ?? [])}${ruleText('exclude', 'scanExclude', data?.rules?.exclude ?? [])}
        <p>${escapeHTML(label('scanRuleSyntax'))}</p>
        <fieldset class="twin__selection"><legend>${escapeHTML(label('scanKinds'))}</legend>${TWIN_KINDS.map(kind => check('kinds', kind, label(`kind.${kind}`), data?.kinds.includes(kind) ?? true)).join('')}</fieldset>
        ${input('intervalMinutes', 'scanInterval', String(data?.intervalMinutes ?? 30), 'number')}
        ${check('enabled', 'on', label('enabled'), data?.enabled ?? true)}
        ${button('previewRule', 'previewRule')}<pre class="twin__preview" data-preview></pre>
        <button type="submit">${escapeHTML(label('save'))}</button></form>`;
}
const ruleText = (name: string, title: string, lines: string[]) => `<label>${escapeHTML(label(title))}<textarea name="${name}" rows="6" placeholder="project:**
file:**/*.md
session:harness/**">${escapeHTML(lines.join('\n'))}</textarea></label>`;

function runs(snapshot: TwinSnapshot): string {
    const worker = snapshot.scans.worker;
    return `<p class="twin__error">${escapeHTML(snapshot.scans.discovery.errors.join(', '))}</p><p>${escapeHTML(label('scanHost'))}: ${escapeHTML(worker.host)} · ${escapeHTML(label(worker.online ? 'scanOnline' : 'scanOffline'))} · ${escapeHTML(worker.error)}</p>
        <p>${escapeHTML(label('scanLeaseHost'))}: ${escapeHTML(worker.ownerHost || label('scanIdle'))}</p>
        <p>${escapeHTML(label('scanHostHelp'))}</p>${snapshot.scans.runs.slice(-50).reverse().map(run => `<article class="twin__card"><h3>${escapeHTML(run.data.name)}</h3>
        <p>${escapeHTML(label(`scanState.${run.data.state}`))} · ${run.data.completedSourceIds.length} / ${run.data.sourceIds.length} · ${escapeHTML(run.data.error)}</p>
        <p>${escapeHTML(label('budget'))}: ${run.data.spentTokens} / ${run.data.reservedTokens} / ${run.data.tokenLimit}</p>
        <p>${date(run.data.createdAt)} · ${escapeHTML(label('scanFinishedAt'))}: ${date(run.data.finishedAt)}</p>
        ${['queued', 'running'].includes(run.data.state) ? button('cancelScanRun', 'cancel', run.id) : run.data.planId && snapshot.scans.plans.some(plan => plan.id === run.data.planId && plan.data.enabled) ? button('runScanPlan', 'scanContinue', run.data.planId) : ''}
        <details><summary>${escapeHTML(label('scanTaskRefs'))}</summary>${snapshot.jobs.filter(job => job.data.scanScope?.runId === run.id).map(job =>
        `<p>${escapeHTML(job.data.sessionId)} / ${escapeHTML(job.data.taskId)} · ${escapeHTML(label(`job.${job.data.state}`))} · ${job.data.offset}–${job.data.end}</p>`).join('') || escapeHTML(label('scanNoModel'))}</details></article>`).join('')}`;
}
const date = (value: number, enabled = true) => value && enabled ? escapeHTML(new Date(value).toLocaleString()) : escapeHTML(label('scanNotScheduled'));
const input = (name: string, title: string, value: string, type = 'text') => `<label>${escapeHTML(label(title))}<input name="${name}" type="${type}" value="${escapeAttr(value)}" required${type === 'number' ? ' min="0" step="1"' : ' maxlength="200"'}></label>`;
const check = (name: string, value: string, title: string, checked: boolean) => `<label><input type="checkbox" name="${name}" value="${escapeAttr(value)}"${checked ? ' checked' : ''}>${escapeHTML(title)}</label>`;

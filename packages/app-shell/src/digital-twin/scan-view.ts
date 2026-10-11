import { twinError } from './error-view';
import { escapeHTML, escapeAttr } from '@itookit/common';
import { TWIN_KINDS, type TwinScanPlan, type TwinDataRecord } from '@itookit/app-core';
import { button, label, sources, updateSettings, type TwinSnapshot } from './view';
import { scanListFilters, scanListPagination } from './scan-list';

export type TwinSourcesTab = 'sources' | 'plans' | 'runs';
export function scanPage(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>, tab: TwinSourcesTab): string {
    const tabs = [['plans', 'scanPlans', snapshot.scans.plans.length], ['sources', 'scanTargets', snapshot.sources.length], ['runs', 'scanRuns', snapshot.scans.runs.length]] as const;
    const configured = connections.some(connection => connection.id === snapshot.settings.data.connectionId);
    return scanSummary(snapshot)
        + `<details class="twin__panel" data-scan-settings data-configured="${configured}"${configured ? '' : ' open'}><summary>${escapeHTML(label('updateSettings'))}</summary>${updateSettings(snapshot, connections)}</details>`
        + `<nav class="twin__scan-tabs" role="tablist" aria-label="${escapeAttr(label('sources'))}">${tabs.map(([id, title, count]) => `<button type="button" role="tab" id="twin-scan-tab-${id}" data-action="scanTab" data-id="${id}" aria-controls="twin-scan-panel-${id}" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}">${escapeHTML(label(title))}<span class="twin__count">${count}</span></button>`).join('')}</nav>`
        + `<section class="twin__scan-panel" id="twin-scan-panel-plans" role="tabpanel" aria-labelledby="twin-scan-tab-plans"${tab !== 'plans' ? ' hidden' : ''}>${plans(snapshot, connections)}</section>`
        + `<section class="twin__scan-panel" id="twin-scan-panel-sources" role="tabpanel" aria-labelledby="twin-scan-tab-sources"${tab !== 'sources' ? ' hidden' : ''}><h3>${escapeHTML(label('scanTargets'))}</h3><p class="twin__help">${escapeHTML(label('scanTargetsHelp'))}</p>${sources(snapshot, connections)}</section>`
        + `<section class="twin__scan-panel" id="twin-scan-panel-runs" role="tabpanel" aria-labelledby="twin-scan-tab-runs"${tab !== 'runs' ? ' hidden' : ''}>${runs(snapshot)}</section>`;
}

function scanSummary(snapshot: TwinSnapshot): string {
    const metrics = [['updateRules', snapshot.scans.plans.filter(plan => plan.data.enabled).length],
        ['connectedSources', snapshot.sources.filter(source => source.data.enabled).length],
        ['activeKnowledge', snapshot.memories.filter(memory => memory.supported && memory.data.state === 'active').length]] as const;
    return `<header class="twin__intro"><p class="twin__help">${escapeHTML(label('updatesSubtitle'))}</p>
        <span class="twin__badge">${escapeHTML(label(snapshot.settings.data.paused ? 'updatesPaused' : 'updatesEnabled'))}</span></header>
        <div class="twin__metrics">${metrics.map(([key, value]) => `<div class="twin__metric"><strong>${value}</strong><span>${escapeHTML(label(key))}</span></div>`).join('')}</div>`;
}

function plans(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>): string {
    return `<section class="twin__rules" data-scan-list="plans"><header class="twin__section-header"><div><h3>${escapeHTML(label('updateRules'))}</h3><p>${escapeHTML(label('scanRulesHelp'))}</p></div></header>
        <p class="twin__help">${escapeHTML(label('updateAvailability'))}</p>
        ${!snapshot.settings.data.connectionId ? `<p>${escapeHTML(label('connectionRequired'))}</p>` : ''}
        <details class="twin__panel"><summary>${escapeHTML(label('addScanPlan'))}</summary><p class="twin__help">${escapeHTML(label('scanPlanHelp'))}</p>${planForm(snapshot, connections)}</details>
        ${scanListFilters('plans')}
        ${snapshot.scans.plans.length ? snapshot.scans.plans.map(plan => planCard(snapshot, connections, plan)).join('')
            : `<div class="twin__empty"><strong>${escapeHTML(label('rulesEmpty'))}</strong><p>${escapeHTML(label('rulesEmptyHelp'))}</p></div>`}${scanListPagination()}</section>`;
}
function planCard(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>, plan: TwinDataRecord<TwinScanPlan>): string {
    const latest = snapshot.scans.runs.filter(run => run.data.planId === plan.id).sort((a, b) => b.data.createdAt - a.data.createdAt)[0];
    const next = snapshot.scans.schedules.find(schedule => schedule.planId === plan.id)?.nextAt ?? 0;
    const query = [plan.data.name, plan.data.focus, ...(plan.data.rules?.include ?? []), ...(plan.data.rules?.exclude ?? []), ...plan.data.kinds].join(' ').toLocaleLowerCase();
    return `<article class="twin__card" data-scan-row="${escapeAttr(plan.id)}" data-scan-text="${escapeAttr(query)}" data-scan-enabled="${plan.data.enabled}"><header class="twin__section-header"><h3>${escapeHTML(plan.data.name)}</h3>
        <span class="twin__badge">${escapeHTML(label(plan.data.enabled ? 'ruleEnabled' : 'disabled'))} · ${plan.data.intervalMinutes} ${escapeHTML(label('minutes'))}</span></header>
        <p>${escapeHTML(plan.data.focus || label('allTopics'))}</p>
        <p>${escapeHTML(label('lastUpdate'))}: ${latest ? date(latest.data.finishedAt || latest.data.startedAt) + ' · ' + escapeHTML(label(`scanState.${latest.data.state}`)) : escapeHTML(label('neverUpdated'))}</p>
        <p>${escapeHTML(label('scanNextAt'))}: ${date(next, plan.data.enabled && plan.data.trigger !== 'manual')}</p>
        ${latest ? `<p>${escapeHTML(label('updatedSources'))}: ${latest.data.completedSourceIds.length} · ${escapeHTML(label('newMemories'))}: ${snapshot.jobs.filter(job => job.data.scanScope?.runId === latest.id).reduce((sum, job) => sum + (job.data.addedMemories ?? 0), 0)}</p>` : ''}
        ${plan.data.enabled ? button('runScanPlan', 'scanNow', plan.id) + button('pauseScanPlan', 'pauseScanPlan', plan.id) : button('enableScanPlan', 'enableScanPlan', plan.id)}
        ${button('removeScanPlan', 'removeScanPlan', plan.id)}<details><summary>${escapeHTML(label('editScanPlan'))}</summary>${planForm(snapshot, connections, plan)}</details></article>`;
}

function planForm(_snapshot: TwinSnapshot, _connections: Array<{ id: string; name: string }>, plan?: TwinDataRecord<TwinScanPlan>): string {
    const data = plan?.data;
    return `<form class="twin__form" data-form="scanPlan" data-id="${escapeAttr(plan?.id ?? '')}">
        ${input('name', 'scanName', data?.name ?? '')}
        ${ruleText('include', 'scanInclude', data?.rules?.include ?? [])}
        <label>${escapeHTML(label('scanFocus'))}<textarea name="focus" maxlength="2000" placeholder="${escapeAttr(label('scanFocusPlaceholder'))}">${escapeHTML(data?.focus ?? '')}</textarea></label>
        ${ruleText('exclude', 'scanExclude', data?.rules?.exclude ?? [])}
        <p>${escapeHTML(label('scanRuleSyntax'))}</p>
        <details><summary>${escapeHTML(label('advanced'))}</summary><fieldset class="twin__selection"><legend>${escapeHTML(label('scanKinds'))}</legend>${TWIN_KINDS.map(kind => check('kinds', kind, label(`kind.${kind}`), data?.kinds.includes(kind) ?? true)).join('')}</fieldset></details>
        ${input('intervalMinutes', 'scanInterval', String(data?.intervalMinutes ?? 30), 'number')}
        ${check('enabled', 'on', label('enabled'), data?.enabled ?? true)}
        ${button('previewRule', 'previewRule')}<pre class="twin__preview" data-preview></pre>
        <button type="submit">${escapeHTML(label('save'))}</button></form>`;
}
const ruleText = (name: string, title: string, lines: string[]) => `<label>${escapeHTML(label(title))}<textarea name="${name}" rows="4" placeholder="${name === 'include' ? 'project:Alpha' : '**/*.log&#10;drafts/'}">${escapeHTML(lines.join('\n'))}</textarea></label>`;

function runs(snapshot: TwinSnapshot): string {
    const worker = snapshot.scans.worker;
    return `<p class="twin__error">${escapeHTML(snapshot.scans.discovery.errors.join(', '))}</p><p>${escapeHTML(label('scanHost'))}: ${escapeHTML(worker.host)} · ${escapeHTML(label(worker.online ? 'scanOnline' : 'scanOffline'))} · ${escapeHTML(worker.error)}</p>
        <p>${escapeHTML(label('scanLeaseHost'))}: ${escapeHTML(worker.ownerHost || label('scanIdle'))}</p>
        <p>${escapeHTML(label('scanHostHelp'))}</p>${snapshot.scans.runs.slice(-50).reverse().map(run => `<article class="twin__card"><h3>${escapeHTML(run.data.name)}</h3>
        <p>${escapeHTML(label(`scanState.${run.data.state}`))} · ${run.data.completedSourceIds.length} / ${run.data.sourceIds.length} · ${escapeHTML(twinError(run.data.error, run.data.errorDetail))}</p>
        <p>${escapeHTML(label('budget'))}: ${run.data.spentTokens} / ${run.data.reservedTokens} / ${run.data.budgetUnlimited ? escapeHTML(label('unlimited')) : run.data.tokenLimit}</p>
        <p>${date(run.data.createdAt)} · ${escapeHTML(label('scanFinishedAt'))}: ${date(run.data.finishedAt)}</p>
        ${['queued', 'running'].includes(run.data.state) ? button('cancelScanRun', 'cancel', run.id) : run.data.planId && snapshot.scans.plans.some(plan => plan.id === run.data.planId && plan.data.enabled) ? button('runScanPlan', 'scanContinue', run.data.planId) : ''}
        <details><summary>${escapeHTML(label('scanTaskRefs'))}</summary>${snapshot.jobs.filter(job => job.data.scanScope?.runId === run.id).map(job =>
        `<p>${escapeHTML(job.data.sessionId)} / ${escapeHTML(job.data.taskId)} · ${escapeHTML(label(`job.${job.data.state}`))} · ${job.data.offset}–${job.data.end}</p>`).join('') || escapeHTML(label('scanNoModel'))}</details></article>`).join('')}`;
}
const date = (value: number, enabled = true) => value && enabled ? escapeHTML(new Date(value).toLocaleString()) : escapeHTML(label('scanNotScheduled'));
const input = (name: string, title: string, value: string, type = 'text') => `<label>${escapeHTML(label(title))}<input name="${name}" type="${type}" value="${escapeAttr(value)}" required${type === 'number' ? ' min="1" max="10080" step="1"' : ' maxlength="200"'}></label>`;
const check = (name: string, value: string, title: string, checked: boolean) => `<label><input type="checkbox" name="${name}" value="${escapeAttr(value)}"${checked ? ' checked' : ''}>${escapeHTML(title)}</label>`;

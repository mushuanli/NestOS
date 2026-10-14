import { twinError } from './error-view';
import { escapeHTML, escapeAttr } from '@itookit/common';
import type { DigitalTwinService } from '@itookit/app-contracts/services';
import { label } from './view';
export type SourceInfo = Awaited<ReturnType<DigitalTwinService['selectionInfo']>>;
export function analysisHTML(info: SourceInfo, historyLimit = 20): string {
    const memories = info.memories.map(memory => `<article class="twin-source-dialog__memory" data-memory="${escapeAttr(memory.id)}">
        <div class="twin-source-dialog__meta"><span>${escapeHTML(label(`kind.${memory.data.kind}`))}</span><strong>${escapeHTML(memory.data.subject)}</strong><button type="button" data-edit="${escapeAttr(memory.id)}">${escapeHTML(label('analysisEdit'))}</button></div>
        <p>${escapeHTML(memory.data.content)}</p>${memory.data.independent ? `<small>${escapeHTML(label('analysisEdited'))}</small>` : ''}${memory.data.quote ? `<blockquote>${escapeHTML(memory.data.quote)}</blockquote>` : ''}</article>`).join('');
    const sources = info.sources.map(source => `<li><strong>${escapeHTML(source.data.label)}</strong><span>${escapeHTML(label(`source.${source.data.status}`))} · ${source.data.offset} / ${source.data.characters}</span></li>`).join('');
    const jobs = [...info.jobs].sort((a, b) => jobTime(b, info) - jobTime(a, info)).slice(0, historyLimit).map(job => jobHTML(job, info)).join('');
    const runs = [...info.runs].filter(run => run.data.planId === info.plan?.id || info.jobs.some(job => job.data.scanScope?.runId === run.id)
        || run.data.sourceIds?.some(id => info.sources.some(source => source.id === id))).sort((a, b) => b.data.createdAt - a.data.createdAt).slice(0, historyLimit).map(run =>
        `<li><strong>${escapeHTML(label(`scanState.${run.data.state}`))}</strong><span>${run.data.completedSourceIds?.length ?? 0} / ${run.data.sourceIds?.length ?? 0} ${escapeHTML(label('analysisDocuments'))}</span>
        <div class="twin-source-dialog__job-times">${timeHTML(run.data)}</div>${run.data.error ? `<p>${escapeHTML(twinError(run.data.error, run.data.errorDetail))}</p>` : ''}</li>`).join('');
    const more = Math.max(info.jobs.length, info.runs.length) > historyLimit;
    return `<section><h3 class="twin-source-dialog__section-title">${escapeHTML(label('analysisResults'))}<span>${info.memories.length}</span></h3>
        ${memories || `<div class="twin-source-dialog__empty"><strong>${escapeHTML(label('analysisEmpty'))}</strong><p>${escapeHTML(label(info.included ? 'analysisPendingHelp' : 'analysisEmptyHelp'))}</p></div>`}</section>
        ${sources || jobs || runs ? `<details class="twin-source-dialog__details"><summary>${escapeHTML(label('analysisActivity'))} · ${info.runs.length} ${escapeHTML(label('analysisRuns'))} · ${info.jobs.length} ${escapeHTML(label('analysisTasks'))}</summary>
        <ul>${sources}${runs}${jobs}</ul>${more ? `<button type="button" data-show-history>${escapeHTML(label('analysisShowHistory'))}</button>` : ''}</details>` : ''}`;

}

/** Scope progress to this selection and the newest run, never unrelated historical failures. */
export function analysisProgress(info: SourceInfo): { key: string; detail?: string } {
    if (info.ignored || !info.included) return { key: info.ignored ? 'selectionRemoved' : 'selectionAbsent' };
    if (!info.settings.data.connectionId) return { key: 'connectionRequired' };
    if (info.settings.data.paused) return { key: 'paused' };
    if (info.worker.error) return { key: 'analysisFailed', detail: info.worker.error };
    const latest = currentAnalysisRun(info);
    if (latest) {
        const state = latest.data.state;
        if (state === 'running' || state === 'queued') return { key: state === 'running' ? 'analysisRunning' : 'analysisWaiting' };
        if (state === 'failed' || state === 'interrupted') return { key: 'analysisFailed', detail: twinError(latest.data.error, latest.data.errorDetail) };
        if (state === 'paused' || state === 'cancelled') return { key: `scanState.${state}`, detail: twinError(latest.data.error, latest.data.errorDetail) };
    }
    if (info.discoveryErrors.length) return { key: 'analysisFailed', detail: info.discoveryErrors.join(' · ') };
    if (info.sources.some(source => ['inaccessible', 'deleted'].includes(source.data.status))) return { key: 'analysisUnavailable' };
    if (latest?.data.state === 'succeeded') return { key: info.memories.length ? 'analysisComplete' : 'analysisNoResults' };
    return { key: 'analysisWaiting' };
}

export function currentAnalysisRun(info: SourceInfo): SourceInfo['runs'][number] | undefined {
    return [...info.runs].filter(run => !info.plan || run.data.planId !== info.plan.id || run.data.planRevision === info.plan.revision)
        .sort((a, b) => b.data.createdAt - a.data.createdAt)[0];
}

/** Current operation is separate from historical attempts and never invents completion. */
export function analysisStatusHTML(info: SourceInfo, now = Date.now()): string {
    const progress = analysisProgress(info), run = currentAnalysisRun(info);
    const times = run ? timeHTML(run.data) : info.plan?.data.updatedAt ? timeHTML({ createdAt: info.plan.data.updatedAt }) : '';
    const active = run && ['queued', 'running'].includes(run.data.state);
    const elapsed = active ? `<p>${escapeHTML(label(run.data.state === 'running' ? 'analysisElapsed' : 'analysisQueueElapsed'))}: ${Math.max(0, (now - (run.data.startedAt || run.data.createdAt)) / 1000).toFixed(0)} ${escapeHTML(label('seconds'))}</p>` : '';
    const jobs = info.jobs.filter(job => job.data.scanScope?.runId === run?.id);
    const added = jobs.reduce((sum, job) => sum + (job.data.addedMemories ?? 0), 0);
    const result = run ? `<p>${run.data.completedSourceIds?.length ?? 0} / ${run.data.sourceIds?.length ?? 0} ${escapeHTML(label('analysisDocuments'))} · ${escapeHTML(label('analysisAddedResults'))}: ${added}</p>` : '';
    const previous = !run ? [...info.runs].sort((a, b) => b.data.createdAt - a.data.createdAt)[0] : undefined;
    const last = previous ? `<p>${escapeHTML(label('analysisPreviousAttempt'))}: ${escapeHTML(label(`scanState.${previous.data.state}`))}${previous.data.finishedAt ? ` · ${escapeHTML(new Date(previous.data.finishedAt).toLocaleString())}` : ''}</p>` : '';
    const next = info.included && !info.ignored && !info.settings.data.paused && info.nextScanAt > now ? `<p>${escapeHTML(label('analysisNextScan'))}: ${escapeHTML(new Date(info.nextScanAt).toLocaleString())}</p>` : '';
    const failureHelp = progress.key === 'analysisFailed' ? `<p>${escapeHTML(label('analysisFailureHelp'))}</p>` : '';
    const job = [...jobs].sort((a, b) => jobTime(b, info) - jobTime(a, info))[0];
    return `<strong>${escapeHTML(label(progress.key))}</strong>${progress.detail ? `<p>${escapeHTML(progress.detail)}</p>` : ''}
        <div class="twin-source-dialog__job-times">${times}</div>${elapsed}${job ? requestStateHTML(job.data) : ''}${result}${last}${next}${failureHelp}`;
}

function requestStateHTML(data: SourceInfo['jobs'][number]['data']): string {
    const key = data.responseCompletedAt ? 'analysisResponseComplete' : data.responseReceivedAt ? 'analysisResponseReceived'
        : data.requestStartedAt ? 'analysisAwaitingResponse' : '';
    return key ? `<p>${escapeHTML(label(key))}</p>` : '';
}

function jobHTML(job: SourceInfo['jobs'][number], info: SourceInfo): string {
    const data = job.data;
    return `<li><strong>${escapeHTML(label(`job.${data.state}`))}</strong><span>${data.offset}–${data.end}</span>
        <div class="twin-source-dialog__job-times">${jobTimes(data, info)}</div>
        ${requestStateHTML(data)}${requestTimes(data)}
        ${data.error ? `<p role="alert">${escapeHTML(twinError(data.error, data.errorDetail))}</p>` : ''}
        ${data.state === 'failed' && (!data.errorDetail || data.errorDetail === data.error) ? `<p>${escapeHTML(label('analysisMissingError'))}</p>` : ''}
        ${['failed', 'cancelled'].includes(data.state) && data.reservedTokens > 0 ? `<p>${escapeHTML(label('usageUnsettled'))}: ${data.reservedTokens} token</p>` : ''}
        ${data.actualTokens !== undefined ? `<p>${escapeHTML(label('usageSettled'))}: ${data.actualTokens} token</p>` : ''}
        <details><summary>${escapeHTML(label('analysisTaskDetails'))}</summary>
        <p>${escapeHTML(label('connectionId'))}: ${escapeHTML(data.connectionId)}</p>
        <p>${escapeHTML(label('analysisTaskId'))}: <code>${escapeHTML(data.taskId || job.id)}</code></p>
        ${data.error ? `<code>${escapeHTML(data.error)}</code>` : ''}</details></li>`;
}
function requestTimes(data: SourceInfo['jobs'][number]['data']): string {
    return (['requestStartedAt', 'responseReceivedAt', 'responseCompletedAt'] as const).filter(key => data[key]).map(key =>
        `<p>${escapeHTML(label(`analysisTime.${key}`))}: <time datetime="${new Date(data[key]!).toISOString()}">${escapeHTML(new Date(data[key]!).toLocaleString())}</time></p>`).join('');
}
function jobTime(job: SourceInfo['jobs'][number], info: SourceInfo): number {
    return job.data.createdAt ?? info.runs.find(run => run.id === job.data.scanScope?.runId)?.data.createdAt ?? 0;
}
function jobTimes(data: SourceInfo['jobs'][number]['data'], info: SourceInfo): string {
    if (!data.createdAt && !data.startedAt && !data.finishedAt) {
        const run = info.runs.find(run => run.id === data.scanScope?.runId);
        if (run) return escapeHTML(label('analysisScanTime')) + ': ' + timeHTML(run.data);
    }
    return timeHTML(data);
}
function timeHTML(data: { createdAt?: number; startedAt?: number; finishedAt?: number }): string {
    const times = (['createdAt', 'startedAt', 'finishedAt'] as const).filter(key => data[key] !== undefined && data[key]! > 0).map(key => {
        const value = data[key]!;
        return `<span>${escapeHTML(label(`analysisTime.${key}`))}: <time datetime="${new Date(value).toISOString()}">${escapeHTML(new Date(value).toLocaleString())}</time></span>`;
    });
    if (data.startedAt !== undefined && data.finishedAt !== undefined) {
        times.push(`<span>${escapeHTML(label('analysisDuration'))}: ${Math.max(0, (data.finishedAt - data.startedAt) / 1000).toFixed(1)} ${escapeHTML(label('seconds'))}</span>`);
    }
    return times.join('') || escapeHTML(label('analysisTimeMissing'));
}

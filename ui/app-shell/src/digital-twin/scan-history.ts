import {escapeAttr, escapeHTML, t} from '@itookit/common';
import {collectionDestinationSummary} from './collection-destination';
import {twinError} from './error-view';
import {button, label, type TwinSnapshot} from './view';

type Run = TwinSnapshot['scans']['runs'][number];
export function scanRunState(run: Run['data']): string {
    return run.state === 'succeeded' && run.collectionProgress?.complete === false ? label('collectionPending') : label(`scanState.${run.state}`);
}
export function scanCollectionSummary(run: Run['data']): string {
    const progress = run.collectionProgress;
    if (!progress) return '';
    const batch = progress.batchCount === undefined ? '' : `<p>${escapeHTML(t('twin.collectionBatchCount', {count: progress.batchCount}))}</p>`;
    return batch + `<p>${escapeHTML(t('twin.collectionProcessed', {count: progress.processed}))}</p>`;
}
export function scanRunTiming(run: Run['data']): string {
    const time = new Date(run.startedAt || run.createdAt).toLocaleString();
    const duration = run.startedAt > 0 && run.finishedAt >= run.startedAt
        ? ' · ' + t('twin.scannerRunDuration', {count: run.finishedAt - run.startedAt}) : '';
    return escapeHTML(time + ' · ' + scanRunState(run) + duration);
}
export function scannerHistory(planId: string, runs: Run[]): string {
    const recent = runs.filter(run => run.data.planId === planId).sort((a, b) => b.data.createdAt - a.data.createdAt).slice(0, 5);
    if (!recent.length) return `<p>${escapeHTML(label('scannerNoRuns'))}</p>`;
    return `<div data-scanner-latest>${runSummary(recent[0])}</div>
        <details class="twin__scan-history" data-scanner-history="${escapeAttr(planId)}"><summary>${escapeHTML(label('scannerRecentRuns'))}</summary>
        <ol>${recent.map(run => `<li data-scanner-run="${escapeAttr(run.id)}">${runSummary(run)}${collectionDestinationSummary(run.data.collection)}${button('openScanRun', 'scannerRunDetails', run.id)}</li>`).join('')}</ol></details>`;
}
function runSummary(run: Run): string {
    const error = twinError(run.data.error, run.data.errorDetail);
    return `<p>${scanRunTiming(run.data)}</p>${scanCollectionSummary(run.data)}
        ${error ? `<p class="twin__error">${escapeHTML(error)}</p>` : ''}`;
}

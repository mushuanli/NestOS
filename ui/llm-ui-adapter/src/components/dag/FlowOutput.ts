import { escapeHTML, t } from '@itookit/common';
import { flowOutputEntries, nodeOutputEntries, outputText } from '@itookit/llm-flow/contracts';

export function renderFlowOutput(output: unknown, root = false): string {
    const entries = root ? flowOutputEntries(output) : nodeOutputEntries(output);
    if (!entries.length) return `<p class="dag-output__empty">${escapeHTML(t('flow.output.pending'))}</p>`;
    return entries.map(entry => `<section class="dag-output__entry"><h4>${escapeHTML(entry.name)}</h4>
        ${renderReview(entry.value)}<pre class="dag-output__value">${escapeHTML(outputText(entry.value))}</pre></section>`).join('');
}

function renderReview(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const review = value as Record<string, unknown>;
    if (typeof review.stopReason !== 'string' || !review.results || typeof review.results !== 'object') return '';
    const reason = review.stopReason === 'condition_met' ? t('flow.output.condition_met')
        : review.stopReason === 'max_rounds' ? t('flow.output.max_rounds') : review.stopReason;
    const rows = Object.entries(review.results).flatMap(([key, item]) => {
        const result = item as { value?: { score?: unknown }; round?: unknown; current?: boolean } | null;
        if (!result || typeof result.value?.score !== 'number') return [];
        return [`<tr><td>${escapeHTML(key)}</td><td>${result.value.score}</td><td>${escapeHTML(String(result.round ?? ''))}</td>
            <td>${escapeHTML(t(result.current === false ? 'flow.output.stale' : 'flow.output.current'))}</td></tr>`];
    });
    return `<p class="dag-output__summary">${escapeHTML(reason)} · ${escapeHTML(t('flow.output.rounds'))}: ${escapeHTML(String(review.completedRounds ?? review.round ?? ''))}</p>
        <table class="dag-output__scores"><thead><tr>${(['dimension', 'score', 'round', 'version'] as const).map(key => `<th>${escapeHTML(t(`flow.output.${key}`))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

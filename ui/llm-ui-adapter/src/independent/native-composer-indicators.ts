import type {ConversationSnapshot} from '../contracts';
import type {ComposerIndicator} from '@itookit/llm-ui';

import {getLocale, t} from '@itookit/common';
import {conversationBudget} from '../shell/conversation-budget';
import {conversationContext} from '../shell/conversation-metrics';
export function nativeComposerIndicators(state: ConversationSnapshot): readonly ComposerIndicator[] {
    const context = state.metrics?.contextWindow, budget = conversationBudget(state);
    const compact = (n: number) => new Intl.NumberFormat(getLocale(), {notation: 'compact', maximumFractionDigits: 1}).format(n);
    const contextValue = context ? context.usedTokens == null ? compact(context.limitTokens) : `${compact(context.usedTokens)} / ${compact(context.limitTokens)}` : '—';
    const errors = [state.metricsError?.code, ...Object.values(state.metrics?.errors ?? {})].filter(Boolean);
    const notice = errors.length ? t('harness.metricsError', {code: errors.join(', ')}) : '';
    const fetched = state.metrics ? t('harness.budgetFetched', {time: new Date(state.metrics.observedAt).toLocaleString(getLocale(), {hour12: false})}) : '';
    return [{id: 'context', progress: context?.usedTokens != null ? context.usedTokens / context.limitTokens : null, label: t('harness.budgetContext'), value: contextValue,
        detail: [conversationContext(state), fetched, notice].filter(Boolean).join('\n'),
        tone: context?.usedTokens != null && context.usedTokens / context.limitTokens >= 0.9 || state.metricsError || state.metrics?.errors?.context ? 'warning' : 'normal'},
    {id: 'budget', label: budget.label, value: budget.compactValue ?? budget.value, detail: [budget.detail, fetched, notice].filter(Boolean).join('\n'),
        tone: budget.warning || state.metricsError || state.metrics?.errors?.quota ? 'warning' : 'normal'}];
}

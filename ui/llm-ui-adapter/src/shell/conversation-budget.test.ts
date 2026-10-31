import {expect, it} from 'vitest';
import {conversationBudget} from './conversation-budget';
const base = {title: '', messages: [], requests: [], pending: false, gap: false, disconnected: false, canSend: false, canInterrupt: false, canRespond: false};
it('selects quota alone when quota and estimates coexist and summarizes the most constrained window', () => {
    const budget = conversationBudget({...base, usageEstimate: {currency: 'USD', estimatedCostUsd: 23, complete: true},
        metrics: {observedAt: 1, cost: {amountUsd: 17, kind: 'native-estimate'}, quota: {windows: [
            {id: 'primary', usedPercent: 25, windowMinutes: 300}, {id: 'secondary', usedPercent: 95, windowMinutes: 10080}]}}});
    expect(budget).toMatchObject({kind: 'quota', value: '剩余 5%', compactValue: '5%', warning: true});
    expect(budget.detail).toContain('5 小时'); expect(budget.detail).toContain('7 天'); expect(budget.detail).not.toContain('$');
});
it('shows one cost estimate, keeps a reported zero and preserves small nonzero costs', () => {
    const state = {...base, metrics: {observedAt: 1, cost: {amountUsd: 0, kind: 'native-estimate' as const}}, usageEstimate: {currency: 'USD' as const, estimatedCostUsd: 23, complete: true}};
    expect(conversationBudget(state)).toMatchObject({kind: 'cost'});
    expect(conversationBudget(state).value).toContain('0.00'); expect(conversationBudget(state).detail).not.toContain('23');
    const host = (amount: number) => conversationBudget({...base, usageEstimate: {currency: 'USD', estimatedCostUsd: amount, complete: true}});
    expect(host(15.833715).value).toContain('15.83'); expect(host(0.000001).value).toContain('0.000001');
});
it('does not turn missing quota or costs into zero or claim an unavailable estimate', () => {
    expect(conversationBudget(base)).toMatchObject({kind: 'unknown', value: '—'});
    expect(conversationBudget({...base, metrics: {observedAt: 1, quota: {windows: [], unlimited: false}}})).toMatchObject({kind: 'unknown'});
    expect(conversationBudget({...base, usageUnavailable: true, usageEstimate: {currency: 'USD', estimatedCostUsd: 0, complete: true}})).toMatchObject({kind: 'unknown'});
    expect(conversationBudget({...base, metrics: {observedAt: 1, quota: {windows: [{id: 'native', status: 'rejected'}]}}})).toMatchObject({kind: 'quota', value: '已限流'});
});

it('prioritizes subscription percentages over all prices, including exhausted and unused quotas', () => {
    for (const [usedPercent, compactValue] of [[100, '0%'], [0, '100%'], [25, '75%']] as const) {
        expect(conversationBudget({...base, metrics: {observedAt: 1, quota: {windows: [{id: 'primary', usedPercent}]},
            cost: {amountUsd: 0, kind: 'native-estimate'}}, usageEstimate: {currency: 'USD', complete: true, estimatedCostUsd: 123}}))
            .toMatchObject({kind: 'quota', compactValue});
    }
    expect(conversationBudget({...base, metrics: {observedAt: 1, quota: {windows: [], unlimited: false},
        cost: {amountUsd: 2, kind: 'native-estimate'}}})).toMatchObject({kind: 'cost'});
});

import { expect, it } from 'vitest';
import { conversationUsage } from './conversation-usage';
const base = {title: '', messages: [], requests: [], pending: false, gap: false, disconnected: false, canSend: false, canInterrupt: false, canRespond: false};
it('hides unsupported metering and distinguishes an unavailable price from an explicit zero quote', () => {
    expect(conversationUsage(base)).toBe('');
    const usage = {scope: 'transcript' as const, complete: true, observedAt: Date.now(),
        totals: {inputTokens: 100, outputTokens: 20, cacheWriteTokens: 10, cacheReadTokens: 50, reasoningTokens: 5}};
    const unknown = conversationUsage({...base, usage});
    expect(unknown).toContain('180'); expect(unknown).not.toContain('185'); expect(unknown).not.toContain('$0');
    const priced = conversationUsage({...base, usage, usageEstimate: {currency: 'USD', estimatedCostUsd: 0, complete: true}});
    expect(priced).toContain('≈'); expect(priced).toContain('0.00');
});

it('rounds ordinary cost estimates while preserving nonzero sub-cent estimates', () => {
    const usage = {scope: 'transcript' as const, complete: true, observedAt: Date.now(),
        totals: {inputTokens: 100, outputTokens: 20, cacheWriteTokens: 10, cacheReadTokens: 50, reasoningTokens: 5}};
    const estimate = (amount: number) => conversationUsage({...base, usage,
        usageEstimate: {currency: 'USD', estimatedCostUsd: amount, complete: true}});
    expect(estimate(15.833715)).toContain('15.83'); expect(estimate(15.833715)).not.toContain('833715');
    expect(estimate(0.000001)).toContain('0.000001');
});

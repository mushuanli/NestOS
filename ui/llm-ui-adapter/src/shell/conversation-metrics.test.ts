import {expect, it} from 'vitest';
import {conversationMetrics} from './conversation-metrics';
const base = {title: '', messages: [], requests: [], pending: false, gap: false, disconnected: false, canSend: false, canInterrupt: false, canRespond: false};
it('separates current context occupancy from cumulative usage and distinguishes unknowns from zero', () => {
    const rows = conversationMetrics({...base, metrics: {observedAt: 1793440000000, contextWindow: {limitTokens: 200000, usedTokens: 10000},
        cost: {amountUsd: 0, kind: 'native-estimate'}, quota: {windows: [{id: 'primary', usedPercent: 25, windowMinutes: 300, resetsAt: 1793450000000}]}}});
    const text = rows.map(row => row.join(':')).join('\n');
    expect(text).toContain('10,000 / 200,000'); expect(text).toContain('已用 5%'); expect(text).toContain('容量来源：当前会话的原生上报值'); expect(text).toContain('25%'); expect(text).toContain('75%'); expect(text).toContain('5 小时窗口');
    expect(text).not.toContain('原生费用估算'); expect(rows.map(row => row[0])).not.toContain('费用估算');
    const unknown = conversationMetrics(base).map(row => row[1]).join(' ');
    expect(unknown).toContain('尚未提供'); expect(unknown).not.toContain('0%'); expect(unknown).not.toContain('1,000,000'); expect(unknown).not.toContain('容量来源');
});
it('preserves missing occupancy, native limit status and actionable partial-read errors', () => {
    const rows = conversationMetrics({...base, metricsError: {code: 'EIO'}, metrics: {observedAt: 1793440000000,
        contextWindow: {limitTokens: 1000000}, quota: {windows: [{id: 'seven_day', status: 'allowed_warning'}]}, errors: {quota: 'ECAPABILITY'}}});
    const text = rows.map(row => row.join(':')).join(' ');
    expect(text).toContain('1,000,000'); expect(text).toContain('占用未知'); expect(text).toContain('接近限额'); expect(text).toContain('EIO'); expect(text).toContain('ECAPABILITY');
});
it('does not round a nonzero context percentage down to zero', () => {
    const rows = conversationMetrics({...base, metrics: {observedAt: 1, contextWindow: {limitTokens: 200000, usedTokens: 1}}});
    expect(rows[0][1]).toContain('0.0005%');
});

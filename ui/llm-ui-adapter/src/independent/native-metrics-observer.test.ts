import type {ConversationSnapshot} from '../contracts';
import {expect, it, vi} from 'vitest';
import {NativeMetricsObserver} from './native-metrics-observer';
import {nativeComposerIndicators} from './native-composer-indicators';

const base: ConversationSnapshot = {sessionId: 's', title: '', messages: [], requests: [], pending: false, gap: false, disconnected: false,
    canSend: true, canInterrupt: false, canRespond: false, supportsMetrics: true};
it('refreshes only at native turn boundaries, coalesces notifications and suspends hidden views', async () => {
    const read = vi.fn(async () => base), changed = vi.fn();
    const observer = new NativeMetricsObserver({read: vi.fn(), refreshMetrics: read} as never, changed);
    observer.observe(base); await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    observer.observe({...base, messages: [{id: 'delta', role: 'assistant', text: 'Token delta'}]}); expect(read).toHaveBeenCalledOnce();
    const active = {...base, observation: {execution: 'running' as const, activeTurnId: 't', observedAt: 1, source: 'events' as const, connection: 'online' as const, stale: false, receiptUnknown: false}};
    observer.observe(active); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    observer.setActive(false); observer.observe(base); expect(read).toHaveBeenCalledTimes(2);
    observer.setActive(true); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    observer.dispose(); observer.observe(active); expect(read).toHaveBeenCalledTimes(3);
});
it('projects two compact indicators with an exclusive budget and accessible failure details', () => {
    const indicators = nativeComposerIndicators({...base, metrics: {observedAt: 1, contextWindow: {usedTokens: 190000, limitTokens: 200000},
        cost: {amountUsd: 12, kind: 'native-estimate'}, quota: {windows: [{id: 'primary', usedPercent: 95}]}}});
    expect(indicators).toHaveLength(2); expect(indicators[0].tone).toBe('warning'); expect(indicators[1].label).toBe('额度');
    expect(indicators[1].detail).not.toContain('$'); expect(indicators[1].value).toBe('5%');
    const unknown = nativeComposerIndicators({...base, metricsError: {code: 'ETIMEDOUT'}});
    expect(unknown[1].value).toBe('—'); expect(unknown[1].detail).toContain('ETIMEDOUT');
});
it('coalesces a changed turn during an in-flight read and drops responses after disposal', async () => {
    let finish!: (state: ConversationSnapshot) => void;
    const read = vi.fn(() => new Promise<ConversationSnapshot>(resolve => {finish = resolve;})), changed = vi.fn();
    const observer = new NativeMetricsObserver({refreshMetrics: read} as never, changed);
    observer.observe(base);
    observer.observe({...base, observation: {execution: 'running', activeTurnId: 'next', source: 'events', observedAt: 1, connection: 'online', stale: false, receiptUnknown: false}});
    expect(read).toHaveBeenCalledOnce(); finish(base);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    observer.dispose(); finish(base); await Promise.resolve(); expect(changed).toHaveBeenCalledOnce();
});

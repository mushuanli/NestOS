import { expect, it } from 'vitest';
import { createUsageCostEstimator } from '../src/projects/usage-estimator';
import { observeConversation } from '../src/projects/conversation-view';
import type { ModelPricingConfig } from '@itookit/kernel-adapters/contracts';
const tokens = {inputTokens: 1000000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0};
const usage = {sessionId: 's', revision: 'r', complete: true, source: 'native-history' as const, scope: 'transcript' as const, observedAt: Date.now(),
    totals: tokens, entries: [{id: 'e', turnId: 't', providerId: 'p', modelId: 'm', tokens}]};
it('caches quotes per session revision and invalidates them when the supplied pricing changes', () => {
    let pricing: ModelPricingConfig = {model_pricing: [{id: 'default', price: [2, 0, 0, 0], providers: {}}]};
    const quote = createUsageCostEstimator(() => pricing), first = quote(usage);
    expect(first.estimatedCostUsd).toBe(2); expect(quote(usage)).toBe(first);
    pricing = {model_pricing: [{id: 'default', price: [5, 0, 0, 0], providers: {}}]};
    expect(quote(usage).estimatedCostUsd).toBe(5);
    expect(quote({...usage, sessionId: 'other', revision: 'r2'})).not.toBe(first);
});
it('projects injected quotes through all host calls and leaves the native snapshot unmodified', async () => {
    const state = {usage, title: 'native', messages: [], requests: [], pending: false, canSend: true, gap: false, disconnected: false};
    const source = {snapshot: () => state, read: async () => state, subscribe: () => () => {}, refresh: async () => state, close: async () => {}};
    const view = observeConversation(source as never, createUsageCostEstimator(() => ({model_pricing: [{id: 'default', price: [3, 0, 0, 0], providers: {}}]})));
    expect((await view.read()).usageEstimate?.estimatedCostUsd).toBe(3);
    expect((await view.refresh()).usageEstimate?.estimatedCostUsd).toBe(3);
    expect('usageEstimate' in state).toBe(false);
    await view.close();
});

it('keeps native operations usable when an optional pricing policy fails', async () => {
    const state = {usage, title: 'native', sessionId: 's', messages: [], requests: [], pending: false, canSend: true, gap: false, disconnected: false};
    let sent = false;
    const source = {snapshot: () => state, send: async () => {sent = true; return state;}, close: async () => {}};
    const view = observeConversation(source as never, () => {throw new Error('invalid custom policy');});
    const result = await view.send('message');
    expect(sent).toBe(true); expect(result.usageEstimate).toBeUndefined(); expect(result.usage?.sessionId).toBe('s');
    await view.close();
});

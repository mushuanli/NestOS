import { expect, it } from 'vitest';
import { resolveChatModelForTier, resolveChatModelTiers } from '../../src/contracts';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

const provider: Pick<LLMProvider, 'models'> = {models: [
    {id: 'chat', name: 'Chat', category: 'chat'},
    {id: 'legacy', name: 'Legacy'},
    {id: 'image', name: 'Image', category: 'image'},
]};

it('preserves known chat choices in standard and fast tiers without inventing fallback choices', () => {
    const models = resolveChatModelTiers({model: 'image', tiers: {optimal: 'image', standard: 'chat', fast: 'legacy'}}, provider);
    expect(models).toEqual({standard: provider.models[0], fast: provider.models[1]});
    expect(resolveChatModelTiers({model: 'chat'}, provider)).toEqual({optimal: provider.models[0]});
});

it('rejects missing catalog entries and does not hide an invalid configured tier behind the legacy model', () => {
    expect(resolveChatModelTiers({model: 'chat', tiers: {optimal: 'removed', standard: 'removed'}}, provider)).toEqual({});
    expect(resolveChatModelTiers({model: 'chat'}, undefined)).toEqual({});
    expect(resolveChatModelTiers({model: ''}, provider)).toEqual({});
    expect(resolveChatModelTiers({model: 'chat', tiers: {optimal: ''}}, provider)).toEqual({optimal: provider.models[0]});
});

it('matches execution tier fallback without skipping explicitly invalid models', () => {
    const connection = {model: 'legacy', tiers: {optimal: 'chat', standard: 'image'}};
    expect(resolveChatModelForTier(connection, provider, 'optimal')).toBe(provider.models[0]);
    expect(resolveChatModelForTier(connection, provider, 'standard')).toBeUndefined();
    expect(resolveChatModelForTier(connection, provider, 'fast')).toBeUndefined();
    expect(resolveChatModelForTier({model: 'legacy'}, provider, 'fast')).toBe(provider.models[1]);
    expect(resolveChatModelForTier({model: 'chat', tiers: {fast: 'removed'}}, provider, 'fast')).toBeUndefined();
});

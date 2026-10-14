import { expect, it } from 'vitest';
import { composeLlmPresets, parseLLMConfig, serializeLLMConfig, type LLMConfigFile } from '../../src/llm-management/config';
import { createMindosLlmPresets } from '../../src/llm-management/presets';
import { LLMDeviceDriver } from '../../src/llm-management/core';

const config: LLMConfigFile = {
    provider: { id: 'host-test', name: 'Host', implementation: 'openai-compatible', baseURL: 'https://example.invalid', models: [{ id: 'model', name: 'Model' }] },
    connections: [{ id: 'host-connection', name: 'Host', providerId: 'host-test', tiers: { optimal: 'model' } }],
    agents: [{ id: 'host-agent', name: 'Host agent', config: { systemPrompt: 'Host instructions' } }],
    pricing: [{ id: 'host-model', price: [1, 2, 0, 0], providers: { 'host-test': ['model'] } }],
};

it('composes deterministic isolated catalogs without changing the global MindOS presets', () => {
    const base = createMindosLlmPresets(), before = structuredClone(base), source = structuredClone(config);
    const left = composeLlmPresets(base, [config]);
    expect(composeLlmPresets(base, [config])).toEqual(left);
    expect(base).toEqual(before);
    expect(createMindosLlmPresets()).toEqual(before);
    expect(config).toEqual(source);
    const driver = new LLMDeviceDriver({} as never, { presets: left });
    left.agents.find(agent => agent.id === 'host-agent')!.config.systemPrompt = 'Changed';
    expect(driver.getDefaultAgents().find(agent => agent.id === 'host-agent')?.config.systemPrompt).toBe('Host instructions');
    expect(driver.getDefaultConnections()).toContainEqual(expect.objectContaining({ id: 'host-connection' }));
});

it('rejects conflicts atomically and supports explicit keep and replace policies', () => {
    const base = composeLlmPresets({ version: 7 }, [config]);
    const changed = { ...config, provider: { ...config.provider!, name: 'Replacement' } };
    expect(() => composeLlmPresets(base, [changed])).toThrow('Duplicate preset id: host-test');
    expect(() => composeLlmPresets(base, [changed], { onConflict: 'unknown' } as never)).toThrow('Unknown preset conflict policy');
    expect(base.providers['host-test'].name).toBe('Host');
    expect(composeLlmPresets(base, [changed], { onConflict: 'keep' })).toEqual(base);
    const result = composeLlmPresets(base, [changed], { onConflict: 'replace', timestamp: 123 });
    expect(result.providers['host-test'].name).toBe('Replacement');
    expect(result.agents[0].createdAt).toBe(123);
    expect(result.version).toBe(7);
});

it('round trips pricing, including an explicitly empty catalog, through config exports', () => {
    expect(parseLLMConfig(serializeLLMConfig(config)).pricing).toEqual(config.pricing);
    expect(parseLLMConfig(serializeLLMConfig({ pricing: [] })).pricing).toEqual([]);
});

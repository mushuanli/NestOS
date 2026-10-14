/** Provider configuration exports must omit plaintext credentials stored in the profile. */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { getProviderDefs, parseLLMConfig, serializeLLMConfig } from '../../src/llm-management/constants/llm-loader';

const provider = {
    id: 'mock', name: 'Mock', implementation: 'openai-compatible' as const,
    baseURL: 'http://127.0.0.1:8080', apiKey: 'sk-must-not-leak',
    models: [{ id: 'mock-model', name: 'mock-model' }],
};
const connection = { id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' } };

describe('LLM config export', () => {
    it('strips the provider api key while keeping the provider and connection', () => {
        const out = serializeLLMConfig({ provider, connections: [connection] });

        expect(out).not.toContain('sk-must-not-leak');
        expect(out).not.toContain('apiKey');
        const parsed = yaml.load(out) as { provider: Record<string, unknown>; connections: Array<Record<string, unknown>> };
        expect(parsed.provider).toMatchObject({ id: 'mock', baseURL: 'http://127.0.0.1:8080' });
        expect(parsed.connections).toEqual([connection]);
    });

    it('strips the key from every provider of a multi-provider export', () => {
        const out = serializeLLMConfig({
            providers: [provider, { ...provider, id: 'other', apiKey: 'sk-second-secret' }],
        });

        expect(out).not.toContain('sk-must-not-leak');
        expect(out).not.toContain('sk-second-secret');
        const parsed = yaml.load(out) as { providers: Array<Record<string, unknown>> };
        expect(parsed.providers.map(entry => entry.id)).toEqual(['mock', 'other']);
    });

    it('round-trips a serialized export back through the parser without inventing a key', () => {
        const parsed = parseLLMConfig(serializeLLMConfig({ provider, connections: [connection] }));
        const roundTripped = getProviderDefs(parsed)[0];

        expect(roundTripped?.id).toBe('mock');
        expect(roundTripped?.apiKey).toBeUndefined();
    });
});

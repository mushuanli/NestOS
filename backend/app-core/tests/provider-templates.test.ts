import { expect, it, vi } from 'vitest';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import { ProviderTemplates } from '../src/configuration/provider-templates';
import { getLogger } from '@itookit/common';

it('copies only template configuration and keeps new instances and source templates independent', async () => {
    const source: LLMProvider = {id: 'preset', name: 'Preset', implementation: 'custom', baseURL: 'https://example.test',
        apiKey: 'private-key', isBuiltin: true, dailyCosts: {today: {}} as never, enabled: false,
        media: {'speech.synthesize': {adapter: 'doubao-speech'}}, models: [{id: 'tts', name: 'TTS', operations: {
            'speech.synthesize': {inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['voice']}}}]};
    const catalog = new ProviderTemplates([source], () => []), save = vi.fn(async (_provider: LLMProvider) => {});
    source.models[0].name = 'Mutated source';
    await catalog.create('one', 'Work', 'preset', save); await catalog.create('two', 'Personal', 'preset', save);
    const first = save.mock.calls[0][0], second = save.mock.calls[1][0];
    expect(first).toMatchObject({id: 'preset', name: 'Work', enabled: true, isBuiltin: false, baseURL: 'https://example.test'});
    expect(first).not.toHaveProperty('apiKey'); expect(first).not.toHaveProperty('dailyCosts');
    first.models[0].operations!['speech.synthesize']!.voices!.push('extra');
    expect(second.models[0].name).toBe('TTS'); expect(second.models[0].operations!['speech.synthesize']!.voices).toEqual(['voice']);
    expect(catalog.list()).toEqual([{id: 'preset', name: 'Preset'}]);
    const entries = getLogger().query({modules: ['toolbox-provider']});
    expect(entries).toContainEqual(expect.objectContaining({message: 'toolbox.provider.create.completed', data: expect.objectContaining({outcome: 'success', models: 1, operationId: expect.any(String), durationMs: expect.any(Number)})}));
    expect(JSON.stringify(entries)).not.toContain('private-key');
});

it('rejects an unknown preset without saving and preserves persistence failures for the caller', async () => {
    const catalog = new ProviderTemplates([], () => []), save = vi.fn(async (_provider: LLMProvider) => {});
    await expect(catalog.create('one', 'Name', 'missing', save)).rejects.toMatchObject({code: 'PROVIDER_TEMPLATE_MISSING'});
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(catalog.create('two', 'Custom', undefined, save)).rejects.toThrow('Disk unavailable');
    expect(save).toHaveBeenCalledWith({id: 'two', name: 'Custom', implementation: 'openai-compatible', baseURL: '', models: [], isBuiltin: false, enabled: true});
    const entries = getLogger().query({modules: ['toolbox-provider']});
    for (const [stage, code] of [['validation', 'PROVIDER_TEMPLATE_MISSING'], ['persistence', 'PROVIDER_SAVE_FAILED']])
        expect(entries).toContainEqual(expect.objectContaining({message: 'toolbox.provider.create.failed', data: expect.objectContaining({stage, code, outcome: 'failure', operationId: expect.any(String), durationMs: expect.any(Number)})}));
    expect(JSON.stringify(entries)).not.toMatch(/Disk unavailable|private-key/);
});

it('rejects existing templates regardless of their name and blocks duplicate custom names', async () => {
    const current = [{id: 'preset', name: 'Renamed provider'}], save = vi.fn(async (_provider: LLMProvider) => {});
    const catalog = new ProviderTemplates([{id: 'preset', name: 'Preset', implementation: 'custom', baseURL: '', models: []}], () => current);
    await expect(catalog.create('random', 'Other name', 'preset', save)).rejects.toMatchObject({code: 'PROVIDER_ALREADY_EXISTS'});
    await expect(catalog.create('random', '  RENAMED provider ', undefined, save)).rejects.toMatchObject({code: 'PROVIDER_ALREADY_EXISTS'});
    expect(save).not.toHaveBeenCalled();
    current.splice(0);
    await expect(catalog.create('random', 'Restored', 'preset', save)).resolves.toBe('preset');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({id: 'preset', name: 'Restored'}));
});

it('serializes concurrent creation across views so the second request cannot overwrite the first', async () => {
    const current: LLMProvider[] = [], owner = {}, source: LLMProvider = {id: 'preset', name: 'Preset', implementation: 'custom', baseURL: '', models: []};
    const first = new ProviderTemplates([source], () => current, owner), second = new ProviderTemplates([source], () => current, owner);
    const save = vi.fn(async (provider: LLMProvider) => { await Promise.resolve(); current.push(provider); });
    const results = await Promise.allSettled([first.create('one', 'First', 'preset', save), second.create('two', 'Second', 'preset', save)]);
    expect(results[0]).toEqual({status: 'fulfilled', value: 'preset'});
    expect(results[1]).toMatchObject({status: 'rejected', reason: {code: 'PROVIDER_ALREADY_EXISTS'}});
    expect(save).toHaveBeenCalledOnce(); expect(current[0].name).toBe('First');
});

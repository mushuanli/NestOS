import { expect, it, vi } from 'vitest';
import { LLMMediaClient } from '@itookit/driver-llm';
import { createDoubaoSpeechProvider, DOUBAO_SPEECH_REFERENCE } from '../../src/llm-management/constants/catalogs/doubao-speech';
import { createMindosLlmPresets } from '../../src/llm-management/presets';
import { ProviderManager } from '../../src/llm-management/device/provider-manager';
import { LLMDeviceDriver } from '../../src/llm-management/device/llm-device-driver';
import { isProvider } from '../../src/llm-management/device/argument-validation';

it('derives runnable speech metadata from the JSON snapshot without enabling documented-only models', () => {
    const provider = createDoubaoSpeechProvider(), reference = DOUBAO_SPEECH_REFERENCE;
    expect(isProvider(provider)).toBe(true);
    expect(provider.models.map(model => model.id)).toEqual(['seed-tts-2.0']);
    expect(reference.models.some(model => model.kind === 'body-model' && model.support === 'unsupported')).toBe(true);
    const caps = provider.models[0].operations!['speech.synthesize']!;
    expect(caps.voices).toEqual(reference.voices.map(voice => voice.id));
    expect(new Set(caps.voices).size).toBe(reference.voices.length); expect(reference.voices.length).toBeGreaterThan(1);
    expect(caps.formats).toEqual(reference.formats.filter(format => format.support === 'implemented').map(format => format.id));
    expect(caps.features ?? []).not.toContain('instructions'); expect(caps.speedRange).toEqual({min: 0.5, max: 2});
    expect(reference.sources.every(source => source.url.startsWith('https://'))).toBe(true);
    expect(reference.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it.each(DOUBAO_SPEECH_REFERENCE.formats.filter(format => format.support === 'implemented'))('matches documented $id encoding and sample-rate constraints in the real adapter', async format => {
    const provider = createDoubaoSpeechProvider();
    const fetch = vi.fn(async () => new Response(JSON.stringify({code: 0, data: btoa('audio')}) + '\n' + JSON.stringify({code: 20000000, data: null})));
    const result = await new LLMMediaClient({provider, apiKey: 'fixture-key', fetch}).generate({operation: 'speech.synthesize',
        model: provider.models[0].id, input: 'Fixture text', voice: provider.models[0].operations!['speech.synthesize']!.voices![0], format: format.id as 'mp3'});
    expect(result.assets[0].data.byteLength).toBe(5); expect(fetch).toHaveBeenCalledOnce();
    const init = (fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1], body = JSON.parse(String(init.body));
    expect(body.req_params.audio_params).toMatchObject({format: format.wireValue, sample_rate: format.defaultSampleRate});
    expect(format.sampleRates).toContain(body.req_params.audio_params.sample_rate);
});

it('does not advertise or send documented WAV and instruction capabilities before adapter support is complete', async () => {
    const provider = createDoubaoSpeechProvider(), fetch = vi.fn();
    expect(DOUBAO_SPEECH_REFERENCE.formats.find(format => format.id === 'wav')?.support).toBe('unsupported');
    const request = {operation: 'speech.synthesize' as const, model: 'seed-tts-2.0', input: 'Fixture', voice: provider.models[0].operations!['speech.synthesize']!.voices![0], format: 'wav' as const};
    const client = new LLMMediaClient({provider, apiKey: 'fixture-key', fetch});
    await expect(client.generate(request)).rejects.toMatchObject({code: 'MEDIA_FORMAT_UNSUPPORTED'});
    await expect(client.generate({...request, format: 'mp3', instructions: 'Fixture instructions'})).rejects.toMatchObject({code: 'MEDIA_INSTRUCTIONS_UNSUPPORTED'});
    expect(fetch).not.toHaveBeenCalled();
});

it('keeps reference snapshots isolated and preserves stored credentials, endpoint and voice edits', () => {
    const presets = createMindosLlmPresets(), driver = new LLMDeviceDriver({} as never, {presets});
    const references = driver.getProviderReferences(); references['doubao-speech'].voices[0].name = 'Edited by consumer';
    expect(driver.getProviderReferences()['doubao-speech'].voices[0].name).not.toBe('Edited by consumer');
    const manager = new ProviderManager({} as never, {} as never, () => {}, presets);
    Object.assign(manager, {_pricingConfig: {model_pricing: []}});
    const stored = createDoubaoSpeechProvider(); stored.apiKey = 'stored-key'; stored.baseURL = 'https://user.example.test';
    stored.models[0].operations!['speech.synthesize']!.voices = ['custom-authorized-voice'];
    manager.reloadProvidersFrom([stored]);
    expect(manager.getFullProvider(stored.id)).toMatchObject({apiKey: 'stored-key', baseURL: 'https://user.example.test'});
    expect(manager.getProvider(stored.id)!.models[0].operations!['speech.synthesize']!.voices).toEqual(['custom-authorized-voice']);
});

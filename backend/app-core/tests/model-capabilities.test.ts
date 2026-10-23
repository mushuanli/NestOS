import { expect, it } from 'vitest';
import { getLogger } from '@itookit/common';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import { configuredModels, modelCapabilities, runnableModel } from '../src/configuration/model-capabilities';
import { ToolboxImportTrace } from '../src/configuration/toolbox-import-trace';

const provider: LLMProvider = {id: 'fixture', name: 'Fixture', baseURL: 'https://example.invalid', implementation: 'openai-compatible',
    media: {'image.generate': {adapter: 'openai-images'}}, models: [
        {id: 'chat', name: 'Chat', supportsVision: true},
        {id: 'image', name: 'Image', category: 'image', operations: {'image.generate': {inputModalities: ['text'], outputModalities: ['image'], formats: ['png']}}},
        {id: 'audio', name: 'TTS name is insufficient', category: 'audio', supportsAudio: true},
    ]};

it('requires affirmative operations and adapters while keeping catalog capabilities independent of credentials', () => {
    expect(modelCapabilities(provider)).toEqual(['chat', 'vision', 'image.generate', 'audio']);
    expect(modelCapabilities({...provider, media: undefined})).not.toContain('image.generate');
    expect(modelCapabilities(provider)).not.toContain('speech.synthesize');
    expect(modelCapabilities(undefined)).toEqual([]);
    expect(modelCapabilities(provider, [{id: 'unreported', name: 'Unreported', capabilitiesKnown: false}])).toEqual([]);
});

it('restricts connection capabilities to resolved tiers instead of inheriting every provider model', () => {
    const chat = {model: 'chat', tiers: {optimal: 'chat'}} as ConnectionMeta;
    expect(modelCapabilities(provider, configuredModels(chat, provider))).toEqual(['chat', 'vision']);
    const removed = {...chat, tiers: {optimal: 'removed'}};
    expect(configuredModels(removed, provider)).toEqual([]);
    const image = configuredModels({...chat, tiers: {optimal: 'image'}}, provider);
    expect(modelCapabilities(provider, image)).toEqual(['image.generate']);
    expect(runnableModel(provider, image)?.id).toBe('image');
    expect(runnableModel(provider, [provider.models[2]])).toBeUndefined();
});

it('correlates import failures by phase and safe code without recording definitions or raw error messages', async () => {
    const trace = new ToolboxImportTrace(); trace.step('write', 'providers', 0);
    await expect(trace.run(async () => {throw Object.assign(new Error('private-key-and-resource-content'), {code: 'ENOSPC'});})).rejects.toThrow('private-key');
    const entry = getLogger().query({modules: ['toolbox-import']}).findLast(entry => entry.message === 'toolbox.import.failed')!;
    expect(entry.data).toMatchObject({stage: 'write', kind: 'providers', index: 0, code: 'ENOSPC', operationId: expect.any(String)});
    expect(JSON.stringify(entry)).not.toContain('private-key-and-resource-content');
});

it('exposes explicit generation declarations in filters without inventing invocation constraints', () => {
    const model = {id: 'catalog-image', name: 'Image', category: 'image', capabilitiesKnown: true, supportedOperations: ['image.generate']};
    const provider = {id: 'p', media: {'image.generate': {adapter: 'volcengine-images'}}, models: [model]} as LLMProvider;
    expect(modelCapabilities(provider)).toEqual(['image.generate']);
    expect(runnableModel(provider, provider.models)).toBeUndefined();
    expect(modelCapabilities({...provider, media: undefined})).toEqual([]);
    expect(modelCapabilities(provider, [{id: 'seedream-unknown', name: 'Seedream', capabilitiesKnown: false}])).toEqual([]);
});

it('uses only models selected in the connection and defaults unspecified tiers to its primary model', () => {
    const models = [{id: 'primary', name: 'Primary', supportsVision: true}, {id: 'routing', name: 'Routing', supportsTools: true}, {id: 'unused', name: 'Unused', supportsVideo: true}];
    const provider = {models} as LLMProvider;
    expect(configuredModels({model: 'primary', tiers: {optimal: 'primary'}}, provider).map(model => model.id)).toEqual(['primary']);
    expect(modelCapabilities(provider, configuredModels({model: 'primary', tiers: {optimal: 'primary', standard: 'routing'}}, provider)))
        .toEqual(['chat', 'vision', 'tools']);
});

it('keeps audio input distinct from speech synthesis and includes declared video models', () => {
    const provider = {models: [{id: 'input', name: 'Audio input', supportsAudio: true}, {id: 'video', name: 'Video', category: 'video'}]} as LLMProvider;
    expect(modelCapabilities(provider)).toEqual(['chat', 'audio', 'video']);
    expect(modelCapabilities(provider)).not.toContain('speech.synthesize');
});

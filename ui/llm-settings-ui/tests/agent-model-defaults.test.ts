// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderAgentModelDefaults, readAgentModelDefaults } from '../src/editors/agent-model-defaults';

const provider = {id: 'p', name: 'Models', implementation: 'openai-compatible', media: {'image.generate': {adapter: 'openai-images'}, 'speech.synthesize': {adapter: 'openai-speech'}},
    models: [{id: 'chat', name: 'Chat'}, {id: 'image', name: 'Image', category: 'image', operations: {'image.generate': {inputModalities: ['text'], outputModalities: ['image'], formats: ['png']}}},
        {id: 'speech', name: 'Speech', category: 'audio', operations: {'speech.synthesize': {inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['alloy']}}}]};
const connections = ['chat', 'image', 'speech'].map(model => ({id: model, name: model, model, providerId: 'p', enabled: true}));
const service = {getProviders: () => [provider], getConnections: async () => connections, getModelDefaults: async () => ({chat: 'chat'})};
afterEach(() => vi.restoreAllMocks());

it('separates default connection choices by purpose and leaves inheritance explicit', async () => {
    const root = document.createElement('div');
    root.innerHTML = await renderAgentModelDefaults({id: 'a', config: {}, modelDefaults: {'image.generate': 'image'}} as never, service as never);
    const field = (operation: string) => root.querySelector<HTMLSelectElement>(`[data-agent-model-operation="${operation}"]`)!;
    expect([...field('chat').options].map(option => option.value)).toEqual(['', 'chat']);
    expect([...field('image.generate').options].map(option => option.value)).toEqual(['', 'image']);
    expect([...field('speech.synthesize').options].map(option => option.value)).toEqual(['', 'speech']);
    expect(field('chat').options[0].text).toContain('chat');
    expect(readAgentModelDefaults(root)).toEqual({'image.generate': 'image'});
    field('image.generate').value = ''; expect(readAgentModelDefaults(root)).toBeUndefined();
});

it('retains unavailable defaults and points to the affected purpose instead of silently replacing them', async () => {
    const root = document.createElement('div');
    root.innerHTML = await renderAgentModelDefaults({id: 'a', config: {}, modelDefaults: {chat: 'removed'}} as never, service as never);
    expect(root.querySelector<HTMLSelectElement>('[data-agent-model-operation=chat]')!.value).toBe('removed');
    expect(() => readAgentModelDefaults(root)).toThrow('连接已失效');
});

it('keeps saved defaults on catalog errors and logs only safe diagnostic metadata', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {}), root = document.createElement('div');
    root.innerHTML = await renderAgentModelDefaults({id: 'a', config: {}, modelDefaults: {chat: 'kept'}} as never,
        {getConnections: async () => {throw new Error('read failed');}} as never);
    expect(root.querySelector('[role=alert]')?.textContent).toContain('read failed');
    expect(readAgentModelDefaults(root, {chat: 'kept'})).toEqual({chat: 'kept'});
    expect(JSON.stringify(error.mock.calls)).not.toContain('read failed');
});

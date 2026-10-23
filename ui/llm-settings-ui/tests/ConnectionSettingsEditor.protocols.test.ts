// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionSettingsEditor } from '../src/editors/ConnectionSettingsEditor';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

afterEach(() => { document.body.innerHTML = ''; });

it('fixes the provider identity and keeps its protocol choices when saving', async () => {
    const providers: LLMProvider[] = [
        { id: 'chat', name: 'Chat', implementation: 'openai-compatible', baseURL: 'https://chat.example', models: [] },
        { id: 'gemini', name: 'Gemini', implementation: 'gemini', baseURL: 'https://gemini.example', models: [] },
    ];
    const connection = { id: 'c', name: 'Connection', providerId: 'chat', protocol: 'openai-chat' };
    const saveConnection = vi.fn().mockResolvedValue(undefined);
    const service = { getProviders: () => providers, getConnections: async () => [connection],
        getDefaultConnection: async () => null, getFullConnection: async () => connection, saveConnection };
    const container = document.createElement('div'); document.body.append(container);
    const editor = new ConnectionSettingsEditor(container, service as never,
        { target: { kind: 'entity', entityType: 'connection', id: 'c' } } as never);
    await editor.render();
    const protocol = container.querySelector<HTMLSelectElement>('[name="protocol"]')!;
    expect([...protocol.options].map(option => option.value)).toEqual(['', 'openai-chat']);
    const provider = container.querySelector<HTMLSelectElement>('[name="providerId"]')!;
    expect(provider.disabled).toBe(true); expect([...provider.options].map(option => option.value)).toEqual(['chat']);
    const identity = container.querySelector<HTMLInputElement>('input[name="providerId"]')!; identity.value = 'gemini';
    const name = container.querySelector<HTMLInputElement>('[name=name]')!; name.value = 'Renamed';
    name.dispatchEvent(new Event('change', {bubbles: true}));
    expect([...protocol.options].map(option => option.value)).toEqual(['', 'openai-chat']);
    await vi.waitFor(() => expect(saveConnection).toHaveBeenCalledOnce());
    expect(saveConnection.mock.calls[0][0]).toMatchObject({providerId: 'chat', name: 'Renamed', protocol: 'openai-chat'});
    await editor.destroy();
});


it('saves reasoning effort by model and removes legacy capability controls', async () => {
    const provider = { id: 'p', name: 'Provider', implementation: 'openai-compatible', baseURL: 'https://example.com',
        models: [{ id: 'a', name: 'A', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }, { id: 'b', name: 'B', reasoning: { efforts: [{ id: 'high' }] } }] };
    const connection = { id: 'c', name: 'Connection', providerId: 'p', tiers: { optimal: 'a', standard: 'b', fast: 'a' },
        metadata: { reasoningEffort: 'high', tierThinking: { optimal: false }, retained: true } };
    const saveConnection = vi.fn().mockResolvedValue(undefined);
    const service = { getProviders: () => [provider], getConnections: async () => [connection],
        getDefaultConnection: async () => null, getFullConnection: async () => connection, saveConnection };
    const container = document.createElement('div'); document.body.append(container);
    const editor = new ConnectionSettingsEditor(container, service as never,
        { target: { kind: 'entity', entityType: 'connection', id: 'c' } } as never);
    await editor.render();
    expect(container.querySelector('[name="reasoningEffort"], .chk-tier-thinking, .tier-cap-slot')).toBeNull();
    const effort = container.querySelector<HTMLSelectElement>('[data-effort-tier="optimal"]')!;
    expect(effort.value).toBe('high');
    effort.value = 'low'; effort.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(saveConnection).toHaveBeenCalledOnce());
    expect(saveConnection.mock.calls[0][0].metadata).toEqual({ retained: true, modelReasoningEfforts: { a: 'low', b: 'high' } });
    expect(container.querySelector<HTMLSelectElement>('[data-effort-tier="fast"]')!.value).toBe('low');
    expect(container.querySelector<HTMLSelectElement>('[data-effort-tier="standard"]')!.value).toBe('high');
    await editor.destroy();
});

// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import { readProviderForm, renderProtocolOptions, renderProviderAdvanced, syncProtocolControls } from '../src/editors/provider-form';

const provider: LLMProvider = { id: 'gateway', name: 'Gateway', implementation: 'openai-compatible',
    apiKey: 'stored', baseURL: 'https://example.com', models: [],
    supportedProtocols: ['openai-chat', 'anthropic-messages'], defaultProtocol: 'anthropic-messages',
    anthropicPath: '/anthropic/v1/messages' };
afterEach(() => { document.body.innerHTML = ''; });

it('shows configured protocols and preserves unavailable legacy selections for explicit correction', () => {
    const select = document.createElement('select');
    select.innerHTML = renderProtocolOptions(provider, 'gemini-generate');
    expect([...select.options].map(option => option.value)).toEqual(['', 'gemini-generate', 'openai-chat', 'anthropic-messages']);
    expect(select.value).toBe('gemini-generate');
    expect(select.selectedOptions[0].disabled).toBe(true);
});

it('keeps only enabled protocols, updates defaults and preserves hidden path overrides', () => {
    document.body.innerHTML = `<form><input name="baseURL" value="https://unsaved.example.com">
        <input name="apiKey" value="">${renderProviderAdvanced(provider)}</form>`;
    const form = document.querySelector('form')!;
    form.querySelector<HTMLInputElement>('[value="anthropic-messages"][type="checkbox"]')!.checked = false;
    syncProtocolControls(form);
    expect(form.querySelector<HTMLElement>('[data-protocol="anthropic-messages"]')!.hidden).toBe(true);
    expect(readProviderForm(form, provider)).toMatchObject({ apiKey: 'stored', baseURL: 'https://unsaved.example.com',
        supportedProtocols: ['openai-chat'], defaultProtocol: 'openai-chat', anthropicPath: '/anthropic/v1/messages' });
});

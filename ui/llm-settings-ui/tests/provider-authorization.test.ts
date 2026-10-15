// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderAuthorizationPanel } from '../src/editors/provider-authorization';
import { ProviderSettingsEditor } from '../src/editors/ProviderSettingsEditor';
import type { ProviderAuthorizationState } from '@itookit/kernel-adapters/contracts';

afterEach(() => { document.body.replaceChildren(); });
it('opens subscription authorization from OpenAI without changing the API-key provider', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const openai = { id: 'openai', name: 'OpenAI', implementation: 'openai-compatible', apiKey: 'existing-key',
        baseURL: 'https://api.openai.com/v1', supportedProtocols: ['openai-chat'], models: [] };
    const chatgpt = { id: 'chatgpt', name: 'ChatGPT', implementation: 'chatgpt', models: [] };
    const navigate = vi.fn(async () => {}), saveProvider = vi.fn(async () => {});
    let notify = () => {};
    const service = { getProviders: () => [openai, chatgpt], getFullProvider: async () => openai,
        getProviderDefaults: () => ({ chatgpt }), saveProvider, onChange: (callback: () => void) => { notify = callback; return () => {}; } };
    const editor = new ProviderSettingsEditor(root, service as never, {
        target: { kind: 'entity', entityType: 'provider', id: 'openai' }, hostContext: { navigate, toggleSidebar: () => {} },
    });
    try {
        await editor.init(root);
        const form = root.querySelector('form'); notify();
        await Promise.resolve(); expect(root.querySelector('form')).toBe(form);
        const button = [...root.querySelectorAll<HTMLButtonElement>('.settings-page__actions button')]
            .find(item => item.textContent?.includes('ChatGPT'))!;
        expect(button).toBeDefined(); button.click();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ target: 'toolbox', resourceId: '/providers/chatgpt' }));
        expect(saveProvider).not.toHaveBeenCalled(); expect(openai.apiKey).toBe('existing-key');
    } finally { await editor.destroy(); }
});

it('keeps callback input stable during unrelated notifications and refreshes the catalog only after authorization', async () => {
    const root = document.createElement('section'); document.body.append(root);
    let state: ProviderAuthorizationState = { supported: true, status: 'signed-out' }, notify = () => {};
    const pending = { id: 'attempt', url: 'https://auth.openai.com/api/accounts/authorize?state=state',
        callbackUri: 'http://127.0.0.1:12345/auth/callback', expiresAt: Date.now() + 10_000 };
    const complete = vi.fn(async () => { state = { supported: true, status: 'authorized', account: 'safe@example.com' }; return state; });
    const service = { getProviderAuthorization: vi.fn(async () => state),
        beginProviderAuthorization: async () => { state = { supported: true, status: 'pending', pending }; return state; },
        completeProviderAuthorization: complete, onChange: (fn: () => void) => { notify = fn; return () => { notify = () => {}; }; } };
    const authorized = vi.fn(async () => {}), panel = new ProviderAuthorizationPanel(root, 'chatgpt', service as never, authorized);
    await panel.init(); root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-auth-callback]')).not.toBeNull());
    const input = root.querySelector<HTMLInputElement>('[data-auth-callback]')!;
    input.value = pending.callbackUri + '?code=private-code&state=state'; notify();
    await vi.waitFor(() => expect(service.getProviderAuthorization).toHaveBeenCalledTimes(3));
    expect(root.querySelector('[data-auth-callback]')).toBe(input); expect(input.value).toContain('private-code');
    root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(authorized).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledWith('chatgpt', 'attempt', input.value);
    expect(root.querySelector('[data-auth-callback]')).toBeNull(); expect(root.textContent).toContain('safe@example.com');
    panel.destroy(); const count = service.getProviderAuthorization.mock.calls.length; notify();
    expect(service.getProviderAuthorization).toHaveBeenCalledTimes(count);
});

it('shows the subscription type and explicit unsupported status without an API-key form', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const provider = { id: 'chatgpt', name: 'ChatGPT', implementation: 'chatgpt', baseURL: 'https://api.openai.com/v1',
        supportedProtocols: ['openai-responses'], defaultProtocol: 'openai-responses', models: [] };
    const service = { getProviders: () => [provider], getFullProvider: async () => provider,
        getProviderDefaults: () => ({}), getProviderAuthorization: async () => ({ supported: false, status: 'signed-out' }), onChange: () => () => {} };
    const editor = new ProviderSettingsEditor(root, service as never, { target: { kind: 'entity', entityType: 'provider', id: 'chatgpt' } });
    try {
        await editor.init(root);
        expect(root.querySelector<HTMLSelectElement>('[name="implementation"]')!.value).toBe('chatgpt');
        expect(root.querySelector<HTMLElement>('[data-provider-api-key]')!.hidden).toBe(true);
        expect(root.querySelector<HTMLInputElement>('[name="baseURL"]')!.readOnly).toBe(true);
        await vi.waitFor(() => expect(root.querySelector('[data-provider-authorization]')!.textContent).toContain('httpd'));
        expect(root.querySelector('[data-provider-authorization] button')).toBeNull();
    } finally { await editor.destroy(); }
});

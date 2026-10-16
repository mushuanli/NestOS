// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderAuthorizationPanel } from '../src/editors/provider-authorization';
import { ProviderSettingsEditor } from '../src/editors/ProviderSettingsEditor';
import { t, type LocaleKey } from '@itookit/common';
import * as ui from '@itookit/ui-common';
import type { ProviderAuthorizationState } from '@itookit/kernel-adapters/contracts';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function button(root: HTMLElement, key: LocaleKey): HTMLButtonElement {
    return [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === t(key))!;
}
const pendingAuthorization = () => ({ id: 'attempt', url: 'https://auth.openai.com/api/accounts/authorize?state=state&code_challenge=challenge',
    callbackUri: 'http://127.0.0.1:12345/auth/callback', expiresAt: Date.now() + 600_000 });
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
    expect(input.compareDocumentPosition(button(root, 'provider.auth.complete')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const form = document.createElement('form'), saved = vi.fn(); document.body.append(form); form.append(root);
    form.addEventListener('input', saved); form.addEventListener('change', saved);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(saved).not.toHaveBeenCalled();
    input.value = pending.callbackUri + '?code=private-code&state=state'; notify();
    await vi.waitFor(() => expect(service.getProviderAuthorization).toHaveBeenCalledTimes(3));
    expect(root.querySelector('[data-auth-callback]')).toBe(input); expect(input.value).toContain('private-code');
    button(root, 'provider.auth.complete').click();
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


it('displays and copies the complete authorization URL locally without a new server request', async () => {
    const root = document.createElement('section'); document.body.append(root);
    const pending = pendingAuthorization(); pending.url += '&hint=</textarea><img src=x onerror=alert(1)>';
    let state: ProviderAuthorizationState = { supported: true, status: 'pending', pending };
    const read = vi.fn(async () => state), begin = vi.fn();
    const copy = vi.spyOn(ui, 'copyText').mockResolvedValue(true);
    vi.spyOn(ui.Toast, 'success').mockImplementation(() => {});
    const service = { getProviderAuthorization: read, beginProviderAuthorization: begin, onChange: () => () => {},
        cancelProviderAuthorization: async () => { state = { supported: true, status: 'signed-out' }; return state; } };
    const panel = new ProviderAuthorizationPanel(root, 'chatgpt', service as never, async () => {});
    try {
        await panel.init();
        const field = root.querySelector<HTMLTextAreaElement>('[data-auth-url]')!;
        expect(field.readOnly).toBe(true); expect(field.value).toBe(pending.url); expect(root.querySelector('img')).toBeNull();
        const link = root.querySelector('a')!;
        expect(link.textContent).toBe(t('provider.auth.open')); expect(link.getAttribute('href')).toBe(pending.url);
        expect(link.target).toBe('_blank'); expect(link.rel).toContain('noreferrer');
        expect(root.textContent).toContain(t('provider.auth.expires', {time: new Date(pending.expiresAt).toLocaleString('zh-CN')}));
        button(root, 'provider.auth.copy').click();
        await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(pending.url));
        expect(read).toHaveBeenCalledOnce(); expect(begin).not.toHaveBeenCalled();
        button(root, 'action.cancel').click();
        await vi.waitFor(() => expect(root.querySelector('[data-auth-url]')).toBeNull());
        expect(root.querySelector('[data-auth-callback]')).toBeNull();
    } finally { panel.destroy(); }
});

it('selects the full link for manual copy when clipboard access fails', async () => {
    const root = document.createElement('section'); document.body.append(root);
    const pending = pendingAuthorization(), copy = vi.spyOn(ui, 'copyText').mockResolvedValue(false);
    const error = vi.spyOn(ui.Toast, 'error').mockImplementation(() => {});
    const read = vi.fn(async () => ({ supported: true, status: 'pending', pending }));
    const panel = new ProviderAuthorizationPanel(root, 'chatgpt', { getProviderAuthorization: read, onChange: () => () => {} } as never, async () => {});
    try {
        await panel.init(); button(root, 'provider.auth.copy').click();
        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(t('provider.auth.copyFailed')));
        const field = root.querySelector<HTMLTextAreaElement>('[data-auth-url]')!;
        expect(document.activeElement).toBe(field); expect(field.selectionStart).toBe(0); expect(field.selectionEnd).toBe(pending.url.length);
        expect(copy).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
    } finally { panel.destroy(); }
});

it('shows preparation and verification stages and prevents empty or repeated callback submissions', async () => {
    const root = document.createElement('section'); document.body.append(root);
    let state: ProviderAuthorizationState = { supported: true, status: 'signed-out' };
    let finishBegin!: () => void, finishComplete!: () => void;
    const begin = vi.fn(() => new Promise<ProviderAuthorizationState>(resolve => { finishBegin = () => {
        state = { supported: true, status: 'pending', pending: pendingAuthorization() }; resolve(state);
    }; }));
    const complete = vi.fn(() => new Promise<ProviderAuthorizationState>(resolve => { finishComplete = () => {
        state = { supported: true, status: 'authorized' }; resolve(state);
    }; }));
    const error = vi.spyOn(ui.Toast, 'error').mockImplementation(() => {}), authorized = vi.fn(async () => {});
    const panel = new ProviderAuthorizationPanel(root, 'chatgpt', { getProviderAuthorization: async () => state,
        beginProviderAuthorization: begin, completeProviderAuthorization: complete, onChange: () => () => {} } as never, authorized);
    try {
        await panel.init(); const start = button(root, 'provider.auth.continue'); start.click(); start.click();
        expect(begin).toHaveBeenCalledOnce(); expect(root.querySelector('[data-auth-progress]')?.textContent).toBe(t('provider.auth.preparing'));
        finishBegin(); await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));
        button(root, 'provider.auth.complete').click();
        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining(t('provider.auth.callbackRequired'))));
        expect(complete).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));
        const callback = root.querySelector<HTMLInputElement>('[data-auth-callback]')!;
        callback.value = pendingAuthorization().callbackUri + '?code=example&state=state';
        const submit = button(root, 'provider.auth.complete'); submit.click(); submit.click();
        expect(complete).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledWith('chatgpt', 'attempt', callback.value);
        expect(root.querySelector('[data-auth-progress]')?.textContent).toBe(t('provider.auth.verifying'));
        finishComplete(); await vi.waitFor(() => expect(authorized).toHaveBeenCalledOnce());
        expect(root.querySelector('[data-auth-url]')).toBeNull();
    } finally { panel.destroy(); }
});

it('waits for cancellation before regenerating the link and clears the previous callback', async () => {
    const root = document.createElement('section'); document.body.append(root);
    const previous = pendingAuthorization(), next = { ...previous, id: 'next-attempt', url: previous.url + '&attempt=next',
        callbackUri: 'http://127.0.0.1:23456/auth/callback' };
    let state: ProviderAuthorizationState = { supported: true, status: 'pending', pending: previous };
    let finishCancel!: () => void;
    const cancel = vi.fn(() => new Promise<ProviderAuthorizationState>(resolve => { finishCancel = () => {
        state = { supported: true, status: 'signed-out' }; resolve(state);
    }; }));
    const begin = vi.fn(async () => { state = { supported: true, status: 'pending', pending: next }; return state; });
    const complete = vi.fn(async () => { state = { supported: true, status: 'authorized' }; return state; });
    const panel = new ProviderAuthorizationPanel(root, 'chatgpt', { getProviderAuthorization: async () => state,
        cancelProviderAuthorization: cancel, beginProviderAuthorization: begin,
        completeProviderAuthorization: complete, onChange: () => () => {} } as never, async () => {});
    try {
        await panel.init(); root.querySelector<HTMLInputElement>('[data-auth-callback]')!.value = 'previous callback';
        const regenerate = button(root, 'provider.auth.regenerate'); regenerate.click(); regenerate.click();
        expect(cancel).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledWith('chatgpt'); expect(begin).not.toHaveBeenCalled();
        expect(root.getAttribute('aria-busy')).toBe('true'); finishCancel();
        await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));
        expect(begin).toHaveBeenCalledOnce(); expect(begin).toHaveBeenCalledWith('chatgpt');
        expect(root.querySelector<HTMLTextAreaElement>('[data-auth-url]')!.value).toBe(next.url);
        const input = root.querySelector<HTMLInputElement>('[data-auth-callback]')!;
        expect(input.value).toBe(''); expect(input.placeholder).toBe(next.callbackUri);
        input.value = next.callbackUri + '?code=example&state=next'; button(root, 'provider.auth.complete').click();
        await vi.waitFor(() => expect(complete).toHaveBeenCalledWith('chatgpt', next.id, input.value));
    } finally { panel.destroy(); }
});

it('keeps the existing link when cancellation fails without starting another authorization', async () => {
    const root = document.createElement('section'); document.body.append(root);
    const pending = pendingAuthorization(), begin = vi.fn();
    const error = vi.spyOn(ui.Toast, 'error').mockImplementation(() => {});
    const cancel = vi.fn().mockRejectedValue(new Error('Cancellation unavailable'));
    const panel = new ProviderAuthorizationPanel(root, 'chatgpt', {
        getProviderAuthorization: async () => ({ supported: true, status: 'pending', pending }),
        cancelProviderAuthorization: cancel, beginProviderAuthorization: begin, onChange: () => () => {},
    } as never, async () => {});
    try {
        await panel.init(); const input = root.querySelector<HTMLInputElement>('[data-auth-callback]')!; input.value = 'draft';
        button(root, 'provider.auth.regenerate').click();
        await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('Cancellation unavailable')); expect(begin).not.toHaveBeenCalled();
        expect(root.querySelector<HTMLTextAreaElement>('[data-auth-url]')!.value).toBe(pending.url);
        expect(root.querySelector('[data-auth-callback]')).toBe(input); expect(input.value).toBe('draft');
    } finally { panel.destroy(); }
});

it('removes the cancelled link if generating its replacement fails', async () => {
    const root = document.createElement('section'); document.body.append(root);
    let state: ProviderAuthorizationState = { supported: true, status: 'pending', pending: pendingAuthorization() };
    const error = vi.spyOn(ui.Toast, 'error').mockImplementation(() => {});
    const begin = vi.fn().mockRejectedValue(new Error('Authorization network unavailable'));
    const panel = new ProviderAuthorizationPanel(root, 'chatgpt', { getProviderAuthorization: async () => state,
        cancelProviderAuthorization: async () => { state = { supported: true, status: 'signed-out' }; return state; },
        beginProviderAuthorization: begin, onChange: () => () => {},
    } as never, async () => {});
    try {
        await panel.init(); button(root, 'provider.auth.regenerate').click();
        await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('Authorization network unavailable'));
        expect(root.querySelector('[data-auth-url]')).toBeNull(); expect(root.querySelector('[data-auth-callback]')).toBeNull();
        expect(button(root, 'provider.auth.continue').disabled).toBe(false);
    } finally { panel.destroy(); }
});

// @vitest-environment jsdom
// P0-03 delivery note: the API key stays plaintext in the profile (user decision 2026-09-11),
// so the editor must say where it lands and how child processes obtain credentials instead of
// silently implying a secret store.
import { expect, it } from 'vitest';
import { ProviderSettingsEditor } from '../src/editors/ProviderSettingsEditor';

const provider = { id: 'mock', name: 'Mock', implementation: 'openai-compatible', enabled: true,
    baseURL: 'http://127.0.0.1:8399', models: [] };

it('points the page description at the Provider layer for API keys', async () => {
    const container = document.createElement('div');
    const service = { getProviders: () => [provider], getFullProvider: () => ({ ...provider, apiKey: 'sk-secret' }) };
    const editor = new ProviderSettingsEditor(container, service as never, {} as never);
    await editor.render();

    expect(container.querySelector('.settings-page__description')?.textContent).toContain('API Key（认证信息属于 Provider 层）');
});

it('states the plaintext storage path and the child-process injection conventions next to the key field', () => {
    const container = document.createElement('div');
    const service = { getProviders: () => [provider], getFullProvider: () => ({ ...provider, apiKey: 'sk-secret' }) };
    const editor = new ProviderSettingsEditor(container, service as never, {} as never);

    // The key field lives in the edit modal, not in the list page.
    (editor as unknown as { showEditModal(p: unknown): void }).showEditModal(provider);

    const keyInput = document.querySelector<HTMLInputElement>('input[name="apiKey"]');
    expect(keyInput?.type).toBe('password');

    const group = keyInput!.closest('.settings-form__group')!;
    const help = [...group.querySelectorAll('.settings-form__help')].map(node => node.textContent ?? '').join('\n');
    expect(help).toContain('明文');
    expect(help).toContain('/etc/llm/.providers/<id>.json');
    expect(help).toContain('Session Bash 不继承宿主环境');

    document.querySelectorAll('dialog, .ui-modal, .modal').forEach(node => node.remove());
});

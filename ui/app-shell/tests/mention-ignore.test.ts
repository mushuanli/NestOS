// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { MentionPlugin } from '../../llm-ui/src/components/input/plugins/MentionPlugin';
import type { InputPluginContext } from '../../llm-ui/src/components/input/plugins/InputPlugin';

let plugin: MentionPlugin | undefined;
afterEach(() => { plugin?.deactivate(); document.body.replaceChildren(); vi.useRealTimers(); });

function setup(onRequestFiles: ConstructorParameters<typeof MentionPlugin>[0]['onRequestFiles']) {
    const textarea = document.createElement('textarea'); document.body.append(textarea);
    plugin = new MentionPlugin({ onRequestFiles });
    const context: InputPluginContext = { textarea, container: document.body,
        getText: () => textarea.value, setText: vi.fn(), insertAtCursor: vi.fn(), replaceRange: vi.fn(),
        getCursorPosition: () => 1, setCursorPosition: vi.fn(), triggerSend: vi.fn(), focus: () => textarea.focus(), getAgentId: () => '' };
    plugin.activate(context); plugin.onInput('@', 1);
    return plugin;
}

it('keeps the include-ignored toggle available for empty results and forwards it', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => []);
    setup(search);
    await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector('.llm-popup--visible')).not.toBeNull();
    const toggle = document.querySelector<HTMLInputElement>('[data-popup-toggle]')!;
    expect(toggle.checked).toBe(false);
    toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(search).toHaveBeenLastCalledWith('', expect.objectContaining({ includeIgnored: true }));
});

it('does not reopen suggestions when a stale request completes after closing', async () => {
    vi.useFakeTimers();
    let finish!: (files: any[]) => void;
    const search = vi.fn(() => new Promise<any[]>(resolve => { finish = resolve; }));
    const active = setup(search);
    await vi.advanceTimersByTimeAsync(200);
    active.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    finish([{ name: 'stale.txt', path: './stale.txt' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.llm-popup--visible')).toBeNull();
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function setup() {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });
    const host = document.createElement('div'); document.body.append(host);
    const list = vi.fn(async () => []), configure = vi.fn();
    const view = new ChatInput(host, { onSend: vi.fn(), onStop: vi.fn(), onRequestSkills: list, onConfigureCapabilities: configure });
    cleanup.push(() => view.destroy());
    return { host, view, list, configure };
}
it('keeps frequent controls visible, folds advanced settings, and omits skills and grants', () => {
    const { host, view, list } = setup();
    host.querySelector<HTMLButtonElement>('.llm-input__btn--settings')!.click();
    const settings = host.querySelector<HTMLElement>('.llm-input__settings-panel')!;
    expect(settings.querySelector('.llm-input__connection-select')).not.toBeNull();
    expect(settings.querySelector('.llm-input__skill-section')).toBeNull();
    expect(settings.textContent).not.toContain(t('skill.configureCapabilities'));
    expect(list).not.toHaveBeenCalled();
    const advanced = settings.querySelector<HTMLDetailsElement>('details')!; expect(advanced.open).toBe(false);
    expect(advanced.querySelector('.llm-input__flow-id')).not.toBeNull();
    expect(advanced.querySelector('.llm-input__system-prompt-append')).not.toBeNull();
    view.setConfig({ settings: { systemPromptAppend: 'Keep this instruction', flowId: 'flow-1' } });
    advanced.open = true;
    expect(advanced.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this instruction');
    expect(advanced.querySelector<HTMLInputElement>('.llm-input__flow-id')!.value).toBe('flow-1');
});
it('keeps the explicit skills command available in its own manager', async () => {
    const { host, view, list } = setup(); view.showSkillSettings();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(document.querySelector('.settings-modal-overlay .llm-input__skill-section')).not.toBeNull();
    expect(host.querySelector('.llm-input__skill-section')).toBeNull();
    view.showSkillSettings(); expect(document.querySelectorAll('.settings-modal-overlay')).toHaveLength(1);
});


it('reports Agent-only changes immediately even when Session settings stay the same', () => {
    const host = document.createElement('div'); document.body.append(host);
    const changed = vi.fn();
    const view = new ChatInput(host, { onSend: vi.fn(), onStop: vi.fn(), onConfigChange: changed });
    const selectAgent = (view as unknown as { selectAgent: (id: string) => void }).selectAgent.bind(view);
    try {
        selectAgent('first'); selectAgent('second');
        expect(changed.mock.calls.map(([config]) => config.agentId)).toEqual(['first', 'second']);
    } finally { view.destroy(); }
});

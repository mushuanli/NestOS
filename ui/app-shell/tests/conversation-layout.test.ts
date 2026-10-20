// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { ChatInput } from '../../llm-ui-adapter/src/components/input/ChatInputView';
import { NodeRenderer } from '../../llm-ui-adapter/src/components/history/NodeRenderer';
import { NodeTemplates } from '../../llm-ui-adapter/src/components/templates/NodeTemplates';
import {EditController} from '../../llm-ui-adapter/src/components/history/EditController';

const views: ChatInput[] = [];
it('cancels prompt editing without creating a branch and dispatches replacement only on explicit confirmation', () => {
    const changed = vi.fn(), action = vi.fn(), commit = vi.fn();
    const edit = new EditController(changed, action, commit), wrapper = document.createElement('div');
    wrapper.innerHTML = '<button data-action="edit"></button>';
    const actions = document.createElement('div');
    const controller = {content: 'Original', toggleEdit: vi.fn(), setContent(text: string) {this.content = text;}};
    edit.toggleUserEdit('u', controller as never, actions, wrapper); controller.content = 'Cancelled';
    edit.toggleUserEdit('u', controller as never, actions, wrapper);
    expect(controller.content).toBe('Original'); expect(action).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    edit.toggleUserEdit('u', controller as never, actions, wrapper); controller.content = 'Replacement';
    edit.confirmEdit('u', controller as never, actions, wrapper, true);
    expect(changed).toHaveBeenCalledWith('u', 'Replacement', 'user'); expect(action).toHaveBeenCalledWith('edit-and-retry', 'u');
    edit.destroy();
});
it('places distinct edit and continuation branch actions directly below the user prompt', () => {
    const host = document.createElement('div');
    host.innerHTML = NodeTemplates.renderUserBubble({id: 'u', role: 'user', content: 'Prompt', timestamp: 1}, 'Prompt');
    const edit = host.querySelector('[data-action="edit"]')!, branch = host.querySelector('[data-action="create-branch"]')!;
    expect(edit.getAttribute('aria-label')).toBe(t('branch.edit'));
    expect(branch.getAttribute('aria-label')).toBe(t('branch.continue'));
    expect(edit.closest('details')).toBeNull(); expect(branch.closest('details')).toBeNull();
    expect(host.querySelectorAll('[data-action="create-branch"]')).toHaveLength(1);
    expect(host.querySelector('[data-action="confirm-edit"]')?.textContent).toBe(t('branch.editAndRun'));
    expect(host.querySelector('[data-action="save-only"]')).toBeNull();
});
afterEach(() => {
    views.splice(0).forEach(view => view.destroy());
    document.body.replaceChildren(); vi.restoreAllMocks();
});

function setup() {
    const host = document.createElement('div'); document.body.append(host);
    const onSend = vi.fn(async () => {});
    const view = new ChatInput(host, { onSend, onStop: vi.fn(),
        initialAgents: [{ id: 'default', name: 'Assistant', defaultPrompts: [{ name: 'Outline', prompt: 'Draft an outline' }] }],
        onRequestConnections: async () => [
            { id: 'main', name: 'Main connection', provider: 'p', hasApiKey: true, hasTiers: true, isDefault: true,
                tiers: { optimal: 'Deep model', standard: 'Balanced model', fast: 'Fast model' } },
            { id: 'other', name: 'Other connection', provider: 'p', hasApiKey: true, hasTiers: true,
                tiers: { optimal: 'Other deep model', fast: 'Other fast model' } },
        ],
    });
    views.push(view);
    const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
    return { host, view, button, onSend };
}

function selectItem(label: string): void {
    const item = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__item')]
        .find(item => item.querySelector('.llm-popup__item-label')?.textContent === label);
    expect(item).toBeDefined(); item!.click();
}

it('uses one picker for models and connections, keeps forms synchronized, and sends the chosen overrides', async () => {
    const { host, view, button, onSend } = setup(); await view.refreshConnections();
    const trigger = button('.llm-input__model-trigger');
    expect(trigger.textContent).toContain('Deep model');
    expect(trigger.textContent).toContain(t('chatSettings.followDefault'));
    trigger.click(); selectItem('Fast model');
    expect(trigger.textContent).toContain('Fast model');
    expect(host.querySelector('[data-tier="fast"]')?.getAttribute('aria-pressed')).toBe('true');
    trigger.click(); selectItem('Other fast model');
    expect(trigger.textContent).toContain('Other fast model');
    expect(host.querySelector<HTMLSelectElement>('.llm-input__connection-select')?.value).toBe('other');
    expect(host.querySelector('.llm-input__active-badge[data-type="connection"]')).toBeNull();
    view.setConfig({ text: 'hello' }); button('.llm-input__btn--send').click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('hello', [], 'default', expect.objectContaining({ connectionId: 'other', modelTier: 'fast' })));
    trigger.click(); selectItem(t('chatSettings.followDefault'));
    expect(view.getConfig().settings.connectionId).toBeUndefined();
    expect(view.getConfig().settings.modelTier).toBe('auto');
    expect(trigger.textContent).toContain('Deep model');
});

it('keeps secondary actions reachable, closes menus with Escape, and opens help without immediately dismissing it', async () => {
    const { host, button } = setup();
    const menu = host.querySelector<HTMLDetailsElement>('.llm-input__options')!;
    menu.querySelector('summary')!.click();
    expect(menu.open).toBe(true);
    button('.llm-input__btn--websearch').click();
    expect(button('.llm-input__btn--websearch').getAttribute('aria-pressed')).toBe('false');
    button('.llm-input__btn--settings').click();
    expect(menu.open).toBe(false);
    expect(host.querySelector<HTMLElement>('.llm-input__settings-panel')!.style.display).toBe('block');
    button('.llm-input__settings-close').click();
    menu.querySelector('summary')!.click();
    button('.llm-input__btn--more').click();
    expect(host.querySelector<HTMLElement>('.llm-input__help-panel')!.style.display).toBe('block');
    button('.llm-input__help-close').click();
    menu.querySelector('summary')!.click();
    button('.llm-input__btn--settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.open).toBe(false); expect(document.activeElement).toBe(menu.querySelector('summary'));
});

it('closes and disables model changes while running and keeps usage details below the toolbar', async () => {
    const { host, view, button } = setup(); await view.refreshConnections();
    button('.llm-input__model-trigger').click();
    expect(document.querySelector('.llm-popup--visible')).not.toBeNull();
    view.setLoading(true);
    expect(document.querySelector('.llm-popup--visible')).toBeNull();
    expect(button('.llm-input__model-trigger').disabled).toBe(true);
    expect(button('[data-execution-mode="agent"]').disabled).toBe(true);
    view.updateTokenStats({ inputTokens: 100, outputTokens: 20, contextUsageRatio: .2, costUsd: .01,
        durationMs: 1200, rounds: 1, isEstimated: false });
    const usage = host.querySelector<HTMLDetailsElement>('.token-meter')!;
    expect(usage.open).toBe(false); expect(usage.closest('.llm-input__toolbar')).toBeNull();
    usage.querySelector('summary')!.click(); expect(usage.open).toBe(true);
});

it('places message actions after content and keeps completed thinking and tool output collapsed', () => {
    const { element } = NodeRenderer.create({ id: 'a', executorId: 'default', executorType: 'agent', name: 'Assistant',
        status: 'success', startTime: 1, data: { output: 'answer', thought: '<thought>' }, children: [] });
    document.body.append(element);
    expect(element.querySelector('.llm-ui-node__header [data-action]')).toBeNull();
    expect(element.querySelector('.llm-ui-message-footer [data-action="regenerate"]')).not.toBeNull();
    expect(element.querySelector('.llm-ui-message-more [data-action="delete"]')).not.toBeNull();
    expect(element.querySelector('.llm-ui-thought__label')?.getAttribute('aria-expanded')).toBe('false');
    expect(element.querySelector('.llm-ui-thought__content')?.textContent).toBe('<thought>');
    const tool = document.createElement('div');
    tool.innerHTML = NodeTemplates.renderTool({ id: 'tool', executorType: 'tool', name: 'Tool', status: 'success',
        startTime: 1, data: { input: { text: '<input>' }, output: '<output>' } } as never, '');
    expect(tool.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(tool.querySelector('output')).toBeNull();
    expect(tool.querySelector('.llm-ui-node__result')?.textContent).toBe('<output>');
});

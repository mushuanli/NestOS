// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { ChatInput } from '../../llm-ui-adapter/src/components/input/ChatInputView';
import { SessionDraftEditor } from '../../llm-ui-adapter/src/shell/drafts/SessionDraftEditor';
import { buildConnectionOptions } from '../../llm-ui-adapter/src/shell/AgentProvider';
import { PopupPanel } from '../../llm-ui-adapter/src/components/input/plugins/PopupPanel';

const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); document.body.replaceChildren(); vi.restoreAllMocks(); });
const agents = [{id: 'writer', name: 'Writer'}, {id: 'reviewer', name: 'Reviewer'}, {id: 'remote:codex', name: 'Server · Codex'}];
const connection = (id: string, ready = true) => ({id, name: id, provider: id + '-provider', hasApiKey: ready,
    credentialsReady: ready, hasTiers: true, tiers: {optimal: 'Shared model', fast: id + '-fast'}});
function setup() {
    const host = document.createElement('div'); document.body.append(host);
    const onSend = vi.fn(async () => {}), changed = vi.fn(), configure = vi.fn();
    const view = new ChatInput(host, {onSend, onStop: vi.fn(), onDraftChange: changed, initialAgents: agents,
        onConfigureExecutor: configure, initialConfig: {agentId: 'writer'},
        onRequestConnections: async () => [{...connection('first'), isDefault: true}, connection('second'), connection('locked', false)]});
    releases.push(() => view.destroy());
    const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
    return {host, view, onSend, changed, configure, button};
}
function pick(connectionId: string) {
    const group = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__group-title')]
        .find(item => item.textContent === connectionId + ' · ' + connectionId + '-provider');
    const item = group?.nextElementSibling as HTMLElement | undefined;
    expect(item?.querySelector('.llm-popup__item-label')?.textContent).toBe('Shared model'); item!.click();
}

it('selects identical model names on different providers atomically without changing the assistant', async () => {
    const {host, view, button, changed, onSend} = setup(); await view.refreshConnections(); changed.mockClear();
    button('.llm-input__model-trigger').click(); pick('second');
    expect(changed).toHaveBeenCalledOnce();
    expect(view.getConfig()).toMatchObject({agentId: 'writer', settings: {connectionId: 'second', modelTier: 'optimal'}});
    expect(button('.llm-input__model-trigger').textContent).toContain('second');
    expect(button('.llm-input__model-trigger').title).toContain('second-provider');
    view.setConfig({text: 'Review'}); button('.llm-input__btn--send').click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('Review', [], 'writer', expect.objectContaining({connectionId: 'second', modelTier: 'optimal'})));
    expect(host.querySelector('.llm-input__agent-name')?.textContent).toBe('Writer');
});

it('disables unauthenticated model choices and labels defaults without promising automatic routing', async () => {
    const {view, changed, button} = setup(); await view.refreshConnections(); changed.mockClear();
    expect(button('.llm-input__model-trigger').textContent).toContain(t('chatSettings.followDefault'));
    button('.llm-input__model-trigger').click();
    const disabled = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible [aria-disabled="true"]')];
    expect(disabled).toHaveLength(2); disabled.forEach(item => item.click());
    expect(changed).not.toHaveBeenCalled(); expect(view.getConfig().settings.connectionId).toBeUndefined();
    expect(document.querySelector('.llm-popup--visible')).not.toBeNull();
});

it('closes the model picker on a second trigger click after outside-click handling starts', async () => {
    const {view, button} = setup(); await view.refreshConnections();
    button('.llm-input__model-trigger').click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    button('.llm-input__model-trigger').click();
    expect(document.querySelector('.llm-popup--visible')).toBeNull();
    expect(button('.llm-input__model-trigger').getAttribute('aria-expanded')).toBe('false');
});

it('chooses local assistants and remote agents in one picker while preserving the complete draft', async () => {
    const {host, view, changed, onSend, button} = setup();
    const file = new File(['context'], 'context.txt'); view.restoreDraft('Unsent draft', [file], 'reviewer');
    view.setConfig({settings: {connectionId: 'second', modelTier: 'fast'}});
    const choose = (name: string) => {
        button('.llm-input__agent-trigger').click();
        const item = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__item')].find(row => row.textContent?.includes(name));
        expect(item).toBeDefined(); item!.click();
    };
    choose('Server · Codex');
    expect(view.getConfig()).toMatchObject({text: 'Unsent draft', agentId: 'remote:codex', settings: {connectionId: 'second', modelTier: 'fast'}});
    expect(host.querySelector<HTMLElement>('.llm-input__execution-source')!.hidden).toBe(false);
    expect(button('.llm-input__model-trigger').hidden).toBe(true);
    choose('Reviewer');
    expect(view.getConfig().agentId).toBe('reviewer'); expect(button('.llm-input__model-trigger').hidden).toBe(false);
    expect(changed.mock.lastCall?.[1]).toEqual([file]); expect(onSend).not.toHaveBeenCalled();
});

it('switches execution targets while a turn runs without submitting, interrupting or changing that turn', async () => {
    const host = document.createElement('div'); document.body.append(host);
    let finish!: () => void;
    const switchTarget = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), onSend = vi.fn(), stop = vi.fn();
    const view = new ChatInput(host, {onSend, onStop: stop, onSwitchExecutionTarget: switchTarget}); releases.push(() => view.destroy());
    const file = new File(['draft'], 'draft.txt'); view.restoreDraft('Next task', [file], 'default'); view.setLoading(true);
    const switchButton = host.querySelector<HTMLButtonElement>('.llm-input__btn--switch-target')!;
    expect(switchButton.hidden).toBe(false); switchButton.click(); switchButton.click();
    expect(switchTarget).toHaveBeenCalledExactlyOnceWith({text: 'Next task', files: [file]});
    expect(onSend).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(view.getConfig().agentId).toBe('default');
    finish(); await Promise.resolve();
});

it('appends incoming input without replacing an existing draft or its attachments', () => {
    const {view, changed} = setup(), first = new File(['first'], 'first.txt'), next = new File(['next'], 'next.txt');
    view.restoreDraft('Existing input', [first], 'reviewer'); view.appendDraft({text: 'Incoming input', files: [next]});
    expect(view.getConfig()).toMatchObject({text: 'Existing input\n\nIncoming input', agentId: 'reviewer'});
    expect(changed.mock.lastCall?.[1]).toEqual([first, next]);
});

it('shows workflow node configuration instead of a global model or assistant picker', () => {
    const {host, view, button, configure} = setup(); view.selectFlow('report', 4, {});
    expect(button('.llm-input__model-trigger').hidden).toBe(true);
    expect(host.querySelector<HTMLElement>('.llm-input__agent-picker')!.hidden).toBe(true);
    expect(button('.llm-input__flow-configure').hidden).toBe(false);
    expect(button('.llm-input__flow-configure').textContent).toBe(t('chatInput.flowModels'));
    button('.llm-input__flow-configure').click(); expect(configure).toHaveBeenCalledOnce();
    view.setConfig({settings: {flowId: undefined}});
    expect(button('.llm-input__model-trigger').hidden).toBe(false);
    button('.llm-input__btn--configure-agent').click(); expect(configure).toHaveBeenCalledTimes(2);
});

it('saves a project draft before opening the workflow library without materializing or sending it', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const save = vi.fn(async () => {}), navigate = vi.fn(async () => {}), materialize = vi.fn();
    const service = {onChange: () => () => {}, listAgents: () => [], getConnections: async () => [], getDefaultConnection: async () => null};
    const editor = new SessionDraftEditor(host, service as never, {sessionDraft: {save, materialize},
        hostContext: {navigate, toggleSidebar() {}}});
    releases.push(() => editor.destroy()); await editor.init(host);
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!;
    textarea.value = 'Keep this draft'; textarea.dispatchEvent(new Event('input'));
    host.querySelector<HTMLButtonElement>('[data-action="open-flows"]')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith({target: 'flows'}));
    expect(save).toHaveBeenCalled(); expect(save.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
    expect(materialize).not.toHaveBeenCalled(); expect(textarea.value).toBe('Keep this draft');
});

it('keeps provider names and known chat model compatibility in connection choices', async () => {
    const provider = {name: 'Provider display name', models: [{id: 'chat', name: 'Chat model', category: 'chat'}, {id: 'image', name: 'Image model', category: 'image'}]};
    const options = await buildConnectionOptions({getConnections: async () => [{id: 'c', name: 'Connection', providerId: 'p', model: 'chat', tiers: {optimal: 'chat', fast: 'image'}}],
        getDefaultConnection: async () => null, getProvider: () => provider} as never);
    expect(options[0]).toMatchObject({provider: 'p', providerName: 'Provider display name', tiers: {optimal: 'Chat model'}});
    expect(options[0].tiers?.fast).toBeUndefined();
});

it('skips disabled choices when opening and navigating a picker with the keyboard', () => {
    const anchor = document.createElement('button'); document.body.append(anchor);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: vi.fn()});
    const selected = vi.fn(), popup = new PopupPanel(anchor);
    releases.push(() => { popup.destroy(); delete (HTMLElement.prototype as {scrollIntoView?: unknown}).scrollIntoView; });
    popup.show([{id: 'missing', label: 'Missing default', disabled: true}, {id: 'one', label: 'One'},
        {id: 'disabled', label: 'Unavailable', disabled: true}, {id: 'two', label: 'Two'}], {onSelect: selected});
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('One');
    popup.handleKeyDown(new KeyboardEvent('keydown', {key: 'ArrowDown'}));
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('Two');
    popup.handleKeyDown(new KeyboardEvent('keydown', {key: 'Enter'}));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({id: 'two'}));
});

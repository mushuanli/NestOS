// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { ChatInput, type ChatInputOptions } from '../../llm-ui/src/components/input/ChatInputView';
import type { ConnectionOption } from '../../llm-ui/src/domain/types';

const views: ChatInput[] = [];
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ready = (extra: Partial<ConnectionOption> = {}): ConnectionOption => ({id: 'main', name: 'Main connection', provider: 'provider-a',
    hasApiKey: true, credentialsReady: true, isDefault: true, hasTiers: false, tiers: {optimal: 'Chat model'}, ...extra});

function setup(request: () => Promise<ConnectionOption[]>, options: Partial<ChatInputOptions> = {}) {
    const host = document.createElement('div'); document.body.append(host);
    const onSend = vi.fn(async () => {}), navigate = vi.fn();
    const view = new ChatInput(host, {onSend, onStop: vi.fn(), onRequestConnections: request, onNavigateSettings: navigate, ...options});
    views.push(view);
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    const send = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    const notice = host.querySelector<HTMLElement>('.llm-input__connection-notice')!;
    const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
    const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
    const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    return {host, view, onSend, navigate, input, send, notice, button, type, enter};
}

it('keeps mobile Return and IME confirmation out of submission, and tracks composer focus', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({matches: query.includes('pointer: coarse')}));
    const {view, input, host, type, onSend, send} = setup(async () => [ready()]);
    await view.refreshConnections(); type('Keep this mobile draft'); input.focus();
    expect(host.dataset.editorComposing).toBe('true');
    const enter = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}); input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false); expect(onSend).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}));
    expect(onSend).not.toHaveBeenCalled(); input.blur(); expect(host.dataset.editorComposing).toBeUndefined();
    send.click(); await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
});

it('shows the initial check before typing and prevents sending until configuration is known', async () => {
    let resolve!: (value: ConnectionOption[]) => void;
    const {notice, send, type, input} = setup(() => new Promise(done => { resolve = done; }));
    expect(notice.hidden).toBe(false); expect(notice.textContent).toContain(t('chatInput.connectionStatus.loading'));
    type('Keep this draft'); expect(send.disabled).toBe(true);
    resolve([ready()]); await vi.waitFor(() => expect(send.disabled).toBe(false));
    expect(notice.hidden).toBe(true); expect(input.value).toBe('Keep this draft');
});

it('reports a missing default before sending and offers settings and a concrete connection choice', async () => {
    const {view, notice, send, input, onSend, navigate, button, type, enter} = setup(async () => [ready({isDefault: false})]);
    await view.refreshConnections(); type('Draft');
    expect(notice.textContent).toContain(t('chatInput.connectionStatus.noDefault')); expect(send.disabled).toBe(true);
    button('[data-connection-configure]').click(); expect(navigate).toHaveBeenCalledWith({resourceId: 'connections'});
    enter(); await view.refreshConnections(); expect(onSend).not.toHaveBeenCalled(); expect(input.value).toBe('Draft');
    button('[data-connection-choose]').click();
    const model = [...document.querySelectorAll<HTMLElement>('.llm-popup__item')].find(row => row.textContent?.includes('Chat model'))!;
    model.click(); expect(view.getConfig().settings.connectionId).toBe('main'); expect(send.disabled).toBe(false);
});

it('opens the selected provider for OAuth or API-key setup and recovers without sending automatically', async () => {
    let connection = ready({hasApiKey: false, credentialsReady: false});
    const {view, notice, send, navigate, button, onSend, type} = setup(async () => [connection]);
    await view.refreshConnections(); type('Preserved OAuth draft');
    expect(notice.textContent).toContain(t('chatInput.connectionStatus.credentials', {name: connection.name}));
    expect(send.disabled).toBe(true); button('[data-connection-configure]').click();
    expect(navigate).toHaveBeenCalledWith({resourceId: 'providers', anchor: 'provider-a'});
    connection = {...connection, credentialsReady: true}; await view.refreshConnections();
    expect(send.disabled).toBe(false); expect(notice.hidden).toBe(true); expect(onSend).not.toHaveBeenCalled();
    send.click(); await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
});

it('honors host credential readiness even when a key is present', async () => {
    const {view, notice, send} = setup(async () => [ready({hasApiKey: true, credentialsReady: false})]);
    await view.refreshConnections(); expect(send.disabled).toBe(true);
    expect(notice.textContent).toContain(t('chatInput.connectionStatus.credentials', {name: 'Main connection'}));
});

it('does not replace an unavailable explicit connection with a valid default', async () => {
    const {view, notice, send, navigate, button} = setup(async () => [ready()], {initialConfig: {settings: {connectionId: 'deleted'}}});
    await view.refreshConnections(); expect(send.disabled).toBe(true);
    expect(notice.textContent).toContain(t('chatInput.connectionStatus.unavailable', {name: 'deleted'}));
    button('[data-connection-configure]').click(); expect(navigate).toHaveBeenCalledWith({resourceId: 'connections', anchor: 'conn:deleted'});
    expect(view.getConfig().settings.connectionId).toBe('deleted');
});

it('explains disabled connections early and sorts them below ready and incomplete choices', async () => {
    const {view, notice, send, button} = setup(async () => [ready({id: 'off', name: 'A Disabled', enabled: false, isDefault: true}),
        ready({id: 'pending', name: 'B Pending', credentialsReady: false, isDefault: false}), ready({id: 'usable', name: 'Z Ready', isDefault: false})]);
    await view.refreshConnections(); expect(send.disabled).toBe(true);
    expect(notice.textContent).toContain(t('chatInput.connectionStatus.disabled', {name: 'A Disabled'}));
    button('[data-connection-choose]').click();
    const groups = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__group-title')].map(row => row.textContent!);
    expect(groups[0]).toContain('Z Ready'); expect(groups[1]).toContain('B Pending'); expect(groups[2]).toContain('A Disabled');
});

it('links missing models to the selected connection and supports an explicit valid connection without a default', async () => {
    let options = [ready({tiers: {}})];
    const {view, notice, send, navigate, button} = setup(async () => options);
    await view.refreshConnections(); expect(notice.textContent).toContain(t('chatInput.connectionStatus.noModel', {name: 'Main connection'}));
    button('[data-connection-configure]').click(); expect(navigate).toHaveBeenCalledWith({resourceId: 'connections', anchor: 'conn:main'});
    options = [ready({isDefault: false})]; await view.refreshConnections();
    view.setConfig({settings: {connectionId: 'main'}}); expect(send.disabled).toBe(false); expect(notice.hidden).toBe(true);
});

it('shows a retryable read error instead of misreporting a missing default', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = vi.fn().mockRejectedValue(new Error('metadata unavailable'));
    const {notice, send, button} = setup(request);
    await vi.waitFor(() => expect(notice.textContent).toContain(t('chatInput.connectionStatus.failed')));
    expect(notice.textContent).not.toContain(t('chatInput.connectionStatus.noDefault')); expect(send.disabled).toBe(true);
    request.mockResolvedValue([ready()]); button('[data-connection-retry]').click();
    await vi.waitFor(() => expect(notice.hidden).toBe(true)); expect(send.disabled).toBe(false); log.mockRestore();
});

it('rechecks before clearing the draft and catches credentials revoked since the last refresh', async () => {
    let options = [ready()];
    const {view, input, send, onSend, notice} = setup(async () => options);
    await view.refreshConnections(); const file = new File(['context'], 'context.txt'); view.restoreDraft('Keep text and attachment', [file], 'default');
    expect(send.disabled).toBe(false); options = [ready({credentialsReady: false})]; send.click();
    await vi.waitFor(() => expect(send.disabled).toBe(true));
    expect(input.value).toBe('Keep text and attachment'); expect(onSend).not.toHaveBeenCalled();
    expect(notice.hidden).toBe(false);
    options = [ready()]; await view.refreshConnections(); send.click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('Keep text and attachment', [file], 'default', expect.any(Object)));
});

it('abandons preflight if the user edits the input while metadata is being checked', async () => {
    let finish!: (value: ConnectionOption[]) => void;
    const request = vi.fn(async () => [ready()]); const {view, type, send, onSend, input} = setup(request);
    await view.refreshConnections(); type('Original prompt');
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    send.click(); type('Edited prompt'); finish([ready()]);
    await vi.waitFor(() => expect(send.disabled).toBe(false)); expect(onSend).not.toHaveBeenCalled(); expect(input.value).toBe('Edited prompt');
});

it('does not impose local model readiness on native harness, workflow inputs or direct shell commands', async () => {
    const {view, notice, send, type, onSend} = setup(async () => []);
    await view.refreshConnections(); expect(send.disabled).toBe(true);
    view.setConfig({agentId: 'remote:native'}); expect(notice.hidden).toBe(true); expect(send.disabled).toBe(false);
    view.setConfig({agentId: 'default'}); view.selectFlow('workflow', 1, {}); expect(notice.hidden).toBe(true); expect(send.disabled).toBe(false);
    view.setConfig({settings: {flowId: undefined}}); type('!pwd'); expect(send.disabled).toBe(false);
    send.click(); await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
});

it('lets command plugins consume slash commands before model preflight', async () => {
    const {view, type, send, onSend} = setup(async () => []); await view.refreshConnections();
    const command = vi.fn(() => false as const);
    view.registerPlugin({id: 'commands-test', activate() {}, destroy() {}, onBeforeSend: command});
    type('/help'); expect(send.disabled).toBe(false); send.click(); expect(command).toHaveBeenCalledWith('/help'); expect(onSend).not.toHaveBeenCalled();
});

it('sorts assistant choices by successful use while preserving categories and ignoring mere selection or failed sends', async () => {
    const times = new Map([['writer', 10], ['reviewer', 50]]), record = vi.fn((id: string) => times.set(id, 100));
    const {view, type, send, button} = setup(async () => [ready()], {executorUsage: {lastUsed: id => times.get(id) ?? 0, record},
        initialAgents: [{id: 'writer', name: 'Writer', category: 'Assistants'}, {id: 'reviewer', name: 'Reviewer', category: 'Assistants'},
            {id: 'remote:codex', name: 'Remote executor', category: 'Native'}], initialConfig: {agentId: 'writer'}});
    await view.refreshConnections(); button('.llm-input__agent-trigger').click();
    const choices = () => [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__item-label')].map(row => row.textContent);
    expect(choices()).toEqual(['Reviewer', 'Writer', 'Remote executor']); expect(record).not.toHaveBeenCalled();
    [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__item')].find(row => row.textContent?.includes('Writer'))!.click();
    expect(record).not.toHaveBeenCalled(); type('Use writer'); send.click(); await vi.waitFor(() => expect(record).toHaveBeenCalledExactlyOnceWith('writer'));
    button('.llm-input__agent-trigger').click(); expect(choices()[0]).toBe('Writer');
});

it('does not record an executor for a rejected submission or direct commands', async () => {
    const record = vi.fn();
    const {view, type, send} = setup(async () => [ready()], {executorUsage: {lastUsed: () => 0, record}, onSend: async () => false});
    await view.refreshConnections(); type('Rejected'); send.click();
    await vi.waitFor(() => expect(send.disabled).toBe(false)); expect(record).not.toHaveBeenCalled();
    type('!pwd'); send.click(); await Promise.resolve(); expect(record).not.toHaveBeenCalled();
});

it.each(['rejected', 'unknown', 'thrown'])('retains the local draft and attachments when submission is %s', async outcome => {
    const draft = vi.fn();
    const onSend = vi.fn(async () => {
        if (outcome !== 'rejected') throw Object.assign(new Error('Send failed'), {outcome});
        return false;
    });
    const {view, type, send, input} = setup(async () => [ready()], {onSend, onDraftChange: draft});
    await view.refreshConnections();
    const file = new File(['draft'], 'draft.txt'); view.restoreDraft('Keep this draft', [file], 'default');
    const afterSend = vi.fn(); view.registerPlugin({id: 'ack-test', activate() {}, destroy() {}, onAfterSend: afterSend});
    type('Keep this draft'); send.click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    expect(input.value).toBe('Keep this draft'); expect(draft).toHaveBeenLastCalledWith(expect.anything(), [file]);
    expect(afterSend).not.toHaveBeenCalled();
});

it('clears only acknowledged local input and preserves edits and attachments added while awaiting acceptance', async () => {
    const draft = vi.fn();
    let accept!: (accepted?: void | false) => void;
    const onSend = vi.fn(() => new Promise<void | false>(resolve => { accept = resolve; }));
    const {view, type, send, input} = setup(async () => [ready()], {onSend, onDraftChange: draft});
    await view.refreshConnections();
    const submitted = new File(['old'], 'old.txt'), later = new File(['new'], 'new.txt');
    view.restoreDraft('Submitted text', [submitted], 'default'); send.click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(input.value).toBe('Submitted text'); expect(send.disabled).toBe(true);
    view.restoreDraft('Later draft', [later], 'default'); type('Later draft');
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(onSend).toHaveBeenCalledOnce(); accept();
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    expect(input.value).toBe('Later draft'); expect(draft).toHaveBeenLastCalledWith(expect.anything(), [later]);
    send.click(); await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(2)); accept();
    await vi.waitFor(() => expect(input.value).toBe('')); expect(draft).toHaveBeenLastCalledWith(expect.anything(), []);
});

it('preserves an invalid explicit tier instead of displaying and sending the optimal fallback', async () => {
    const {view, notice, send, input, type, onSend} = setup(async () => [ready({
        resolvedTiers: {optimal: 'Chat model', standard: null, fast: null},
    })], {initialConfig: {settings: {connectionId: 'main', modelTier: 'standard'}}});
    await view.refreshConnections(); type('Blocked draft');
    expect(send.disabled).toBe(true); expect(notice.textContent).toContain(t('chatInput.connectionStatus.noModel', {name: 'Main connection'}));
    expect(view.getConfig().settings.modelTier).toBe('standard');
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await view.refreshConnections(); expect(onSend).not.toHaveBeenCalled(); expect(input.value).toBe('Blocked draft');
});

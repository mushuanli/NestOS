// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import type {ConnectionOption} from '../../llm-ui-adapter/src/domain/types';

const views: ChatInput[] = [];
afterEach(() => {views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); vi.unstubAllGlobals();});

const connections: ConnectionOption[] = ['a', 'b'].map(id => ({id, name: id, provider: 'provider', hasApiKey: true,
    isDefault: id === 'a', tiers: {optimal: `${id}-primary`, fast: `${id}-fast`},
    reasoningByTier: {optimal: {efforts: [{id: 'low'}], canDisable: true}, fast: {efforts: [{id: 'high'}], canDisable: true}}}));

function mount(list = vi.fn(async () => connections)) {
    const root = document.createElement('div'); document.body.append(root);
    const changed = vi.fn();
    const view = new ChatInput(root, {onSend: vi.fn(), onStop: vi.fn(), onConfigChange: changed, onRequestConnections: list});
    views.push(view);
    return {root, view, changed};
}

it('preserves explicit reasoning settings before capabilities load and across passive refreshes', async () => {
    const list = vi.fn(async (): Promise<ConnectionOption[]> => []);
    const {view, changed} = mount(list);
    view.setConfig({settings: {connectionId: 'a', modelTier: 'fast', reasoningEffort: 'high', thinkingEnabled: false}});
    await view.refreshConnections();
    expect(view.getConfig().settings).toMatchObject({reasoningEffort: 'high', thinkingEnabled: false});
    list.mockResolvedValue(connections);
    await view.refreshConnections();
    expect(view.getConfig().settings).toMatchObject({reasoningEffort: 'high', thinkingEnabled: false});
    expect(changed).not.toHaveBeenCalled();
});

it('applies incoming model and tier settings together without replacing their reasoning preference', async () => {
    const {root, view} = mount(); await view.refreshConnections();
    view.setConfig({settings: {connectionId: 'a', modelTier: 'optimal', reasoningEffort: 'low'}});
    view.setConfig({settings: {connectionId: 'b', modelTier: 'fast', reasoningEffort: 'high', thinkingEnabled: false}});
    expect(view.getConfig().settings).toMatchObject({connectionId: 'b', modelTier: 'fast', reasoningEffort: 'high', thinkingEnabled: false});
    expect(root.querySelector<HTMLSelectElement>('.llm-input__reasoning-select')!.value).toBe('high');
});

it('remembers per-model preferences only when the user changes selection', async () => {
    const {root, view} = mount(); await view.refreshConnections();
    view.setConfig({settings: {connectionId: 'a', modelTier: 'optimal', reasoningEffort: 'low', thinkingEnabled: false}});
    const select = root.querySelector<HTMLSelectElement>('.llm-input__connection-select')!;
    select.value = 'b'; select.dispatchEvent(new Event('change', {bubbles: true}));
    expect(view.getConfig().settings.reasoningEffort).toBe('auto');
    select.value = 'a'; select.dispatchEvent(new Event('change', {bubbles: true}));
    expect(view.getConfig().settings).toMatchObject({reasoningEffort: 'low', thinkingEnabled: false});
});

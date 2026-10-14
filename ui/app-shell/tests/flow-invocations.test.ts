// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { CommandBus, FlowEngine, FlowDefinitionStore, DagCommandService, FlowInvocationService, FlowCommand, SessionCommand, createBuiltinDagPluginRegistry, registerDurablePrograms } from '@itookit/llm-session';
import { invokeFlowText } from '../../llm-ui/src/flows/invoke-flow';
import { InvocationPanel } from '../../llm-ui/src/flows/InvocationPanel';
import { SlashCommandPlugin } from '../../llm-ui/src/components/input/plugins/SlashCommandPlugin';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import { t } from '@itookit/common';

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, commands: CommandBus, panel: InvocationPanel;
beforeEach(async () => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    const engine = new FlowEngine(await manager.openFileSystem('/flows')); await engine.init();
    const plugins = createBuiltinDagPluginRegistry(), store = new FlowDefinitionStore(engine, plugins);
    const draft = await store.createDraft({ id: 'review', name: 'Review' });
    await store.saveDraft({ ...draft, parameters: [{ name: 'text', type: 'string', required: true }], nodes: [
        { id: 'ask' as never, name: 'Ask', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'same', prompt: '${param.text}' } },
    ] }, draft.draftVersion);
    commands = new CommandBus();
    commands.register(SessionCommand.GetConnections, async () => ({ connections: [] }));
    new DagCommandService({ kernel, plugins, flowStore: store }).register(commands);
    new FlowInvocationService(kernel, store, commands).register();
});
afterEach(async () => {
    panel?.destroy(); await kernel.closeSession('s', true); kernel.dispose(); await kernel.waitIdle();
    await manager.dispose(); document.body.innerHTML = ''; vi.restoreAllMocks();
});
const submit = () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

it('calls a Flow twice through the input form, restores both cards, and routes replies independently', async () => {
    for (const text of ['First', 'Second']) {
        const pending = invokeFlowText(commands, 's', `review ${JSON.stringify({ text })}`);
        await vi.waitFor(() => expect(document.querySelector('dialog textarea')?.textContent).toBe(text));
        submit(); expect(await pending).toBe(true);
    }
    panel = new InvocationPanel(commands, 's', document.body, vi.fn());
    await vi.waitFor(async () => { await panel.refresh(); expect(document.querySelectorAll('.llm-input__interaction')).toHaveLength(2); });
    const cards = [...document.querySelectorAll<HTMLElement>('[data-invocation]')]; expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('First'); expect(cards[1].textContent).toContain('Second');
    const textarea = cards[0].querySelector('textarea')!; textarea.value = 'Reply one';
    cards[0].querySelector<HTMLButtonElement>('[data-interaction-action="reply"]')!.click();
    await vi.waitFor(async () => { await panel.refresh(); expect(cards[0].querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.succeeded')); });
    expect(cards[1].querySelector('.llm-input__interaction')).not.toBeNull();
    panel.destroy(); panel = new InvocationPanel(commands, 's', document.body, vi.fn());
    await vi.waitFor(async () => { await panel.refresh(); expect(document.querySelectorAll('[data-invocation]')).toHaveLength(2); expect(document.querySelectorAll('.llm-input__interaction')).toHaveLength(1); });
});

it('does not launch on cancellation and preserves slash text on a rejected call', async () => {
    const pending = invokeFlowText(commands, 's', 'review');
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); expect(await pending).toBe(false);
    expect(await commands.execute(FlowCommand.RunList, { sessionId: 's' })).toEqual([]);
    const setText = vi.fn(), plugin = new SlashCommandPlugin({ onFlow: async () => false } as never);
    plugin.activate({ setText, focus: vi.fn(), getText: () => '/flow review' } as never);
    expect(plugin.onBeforeSend('/flow review')).toBe(false);
    await Promise.resolve(); expect(setText).not.toHaveBeenCalled(); plugin.deactivate();
});

it('accepts a slash Flow during chat generation without submitting a second ordinary message or losing a new draft', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const onSend = vi.fn(), onFlow = vi.fn<() => Promise<boolean>>();
    let finish!: (value: boolean) => void;
    onFlow.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const input = new ChatInput(container, { onSend, onStop: vi.fn() });
    input.registerPlugin(new SlashCommandPlugin({ onFlow } as never));
    try {
        input.setLoading(true); input.setConfig({ text: 'ordinary draft' });
        const textarea = container.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        expect(textarea.disabled).toBe(false);
        expect(container.querySelector('.llm-input__field-wrapper--disabled')).toBeNull();
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onSend).not.toHaveBeenCalled(); expect(input.getConfig().text).toBe('ordinary draft');
        input.setConfig({ text: '/flow review' });
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => expect(onFlow).toHaveBeenCalledExactlyOnceWith('review'));
        input.setConfig({ text: 'new draft while starting' }); finish(true);
        await Promise.resolve(); await Promise.resolve();
        expect(input.getConfig().text).toBe('new draft while starting'); expect(onSend).not.toHaveBeenCalled();
    } finally { input.destroy(); }
});

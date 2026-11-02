// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../../llm-ui-adapter/src/components/input/ChatInputView';
import { SendMessageCommand } from '../../llm-ui-adapter/src/commands/SendMessageCommand';
import { RegenerateCommand } from '../../llm-ui-adapter/src/commands/NodeCommands';
import { SessionCommand } from '@itookit/llm-session';
import type { ChatOverrides } from '../../llm-ui-adapter/src/domain/types';

const views: ChatInput[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); document.body.innerHTML = ''; });
function fixture() {
    const container = document.createElement('div'); document.body.append(container);
    const onSend = vi.fn(async () => {}), onConfigChange = vi.fn();
    const view = new ChatInput(container, { onSend, onStop: vi.fn(), onConfigChange }); views.push(view);
    const toggle = container.querySelector<HTMLInputElement>('.llm-input__tools-enabled-toggle')!;
    return {container, view, onSend, onConfigChange, toggle};
}

it('controls execution in settings, sends it explicitly, and disables changes while running', async () => {
    const f = fixture(); expect(f.toggle.checked).toBe(false);
    expect(f.container.querySelector('.llm-input__execution-picker')).toBeNull();
    expect(f.toggle.closest('.llm-input__settings-panel')).not.toBeNull();
    f.toggle.click();
    expect(f.onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({settings: expect.objectContaining({executionMode: 'agent'})}));
    f.view.setConfig({text: 'do work'}); f.container.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledWith('do work', [], 'default', expect.objectContaining({executionMode: 'agent'})));
    f.view.setLoading(true); expect(f.toggle.disabled).toBe(true); f.toggle.click();
    expect(f.view.getConfig().settings.executionMode).toBe('agent');
    f.view.setLoading(false); f.view.setConfig({settings: {executionMode: 'chat'}}); expect(f.toggle.checked).toBe(false);
});
it('hides the local preference for Flow while retaining its value', () => {
    const f = fixture(); f.toggle.click(); f.view.selectFlow('review', 2, {});
    expect(f.toggle.disabled).toBe(true); expect(f.toggle.closest<HTMLElement>('.llm-input__tool-execution-setting')!.hidden).toBe(true);
    f.toggle.click(); expect(f.view.getConfig().settings.executionMode).toBe('agent');
    const input = f.container.querySelector<HTMLInputElement>('.llm-input__flow-id')!;
    input.value = ''; input.dispatchEvent(new Event('input'));
    expect(f.toggle.disabled).toBe(false); expect(f.toggle.checked).toBe(true);
});

it('freezes the send mode before an attachment upload and keeps Flow routing authoritative', async () => {
    let uploaded!: (refs: string[]) => void;
    const execute = vi.fn(async () => undefined);
    const context = { getSessionId: () => 's', commands: { execute },
        chatInput: { setConfig: vi.fn(), setLoading: vi.fn(), restoreInput: vi.fn(), getConfig: () => ({ settings: { executionMode: 'agent' } }) },
        historyView: { scrollToBottom: vi.fn() }, errorHandler: { wrap: (run: () => Promise<unknown>) => run() },
        assetService: { prepareUpload: () => new Promise<{references: string[]; files: []}>(resolve => { uploaded = references => resolve({references, files: []}); }) },
    };
    const command = new SendMessageCommand(context as never);
    const overrides: ChatOverrides = { executionMode: 'chat' };
    const sending = command.run({ text: 'goal', files: [new File(['text'], 'note.txt')], overrides });
    overrides.executionMode = 'agent';
    await vi.waitFor(() => expect(uploaded).toBeTypeOf('function'));
    uploaded([]); await sending;
    expect(execute).toHaveBeenCalledWith(SessionCommand.Send, expect.objectContaining({
        overrides: expect.objectContaining({ executionMode: 'chat' }),
        sendIntent: expect.objectContaining({ execution: { kind: 'agent', agentId: 'default', mode: 'chat' } }),
    }));
    expect(context.chatInput.setConfig).toHaveBeenCalledWith({ settings: { executionMode: 'chat', executionModeLocked: true } });
    await command.run({ text: 'flow', files: [], overrides: { executionMode: 'chat', flowId: 'review', flowRevision: 3 } });
    expect(execute).toHaveBeenCalledWith(SessionCommand.Send, expect.objectContaining({ sendIntent: expect.objectContaining({
        execution: { kind: 'flow', flowId: 'review', revision: 3, parameters: undefined },
    }) }));
});

it('uses the selected mode when regenerating an answer', async () => {
    const execute = vi.fn(async (command: string) => command === SessionCommand.GetSessions
        ? [{ id: 'answer', role: 'assistant', executionRoot: { id: 'node' } }]
        : command === SessionCommand.CanRegenerate ? { allowed: true } : undefined);
    const command = new RegenerateCommand({ commands: { execute },
        chatInput: { setLoading: vi.fn(), getConfig: () => ({ settings: { executionMode: 'chat' } }) },
        errorHandler: { wrap: (run: () => Promise<unknown>) => run() },
    } as never);
    await command.run({ nodeId: 'answer' });
    expect(execute).toHaveBeenLastCalledWith(SessionCommand.Regenerate, {
        assistantId: 'answer', options: { overrides: { executionMode: 'chat' } },
    });
});

it('keeps the accepted mode locked after stopping and reopening', () => {
    const f = fixture(); f.view.setConfig({settings: {executionMode: 'agent', executionModeLocked: true}});
    f.view.setLoading(true); f.view.setLoading(false);
    expect(f.toggle.disabled).toBe(true); expect(f.toggle.checked).toBe(true); f.toggle.click();
    expect(f.view.getConfig().settings.executionMode).toBe('agent'); expect(f.toggle.title).toContain('新建会话');
    expect(f.container.querySelector<HTMLElement>('.llm-input__execution-info')!.hidden).toBe(false);
    f.view.setConfig({settings: {executionMode: 'chat', executionModeLocked: false}});
    expect(f.toggle.disabled).toBe(false); expect(f.toggle.checked).toBe(false);
});

it('places immutable mode information in the host menu and removes it when the input closes', () => {
    const host = document.createElement('div'), menu = document.createElement('div'), input = document.createElement('div');
    host.append(menu, input); document.body.append(host);
    const view = new ChatInput(input, { executionModeInfo: menu, onSend: async () => {}, onStop: () => {},
        initialConfig: { settings: { executionMode: 'agent', executionModeLocked: true } } }); views.push(view);
    const info = menu.querySelector<HTMLElement>('.llm-input__execution-info')!;
    expect(info.hidden).toBe(false); expect(info.textContent).toContain('执行'); expect(info.querySelector('button')).toBeNull();
    expect(input.querySelector('.llm-input__execution-info')).toBeNull();
    expect(input.querySelector<HTMLInputElement>('.llm-input__tools-enabled-toggle')!.disabled).toBe(true);
    view.setLoading(true); view.setLoading(false); expect(info.hidden).toBe(false);
    view.setConfig({ agentId: 'remote:native' }); expect(info.hidden).toBe(true);
    view.setConfig({ agentId: 'default' }); expect(info.hidden).toBe(false);
    view.destroy(); views.splice(views.indexOf(view), 1); expect(menu.children).toHaveLength(0);
});

it('shows the host exchange budget instead of a fixed Agent limit', () => {
    const container = document.createElement('div'); document.body.append(container);
    const view = new ChatInput(container, { onSend: async () => {}, onStop: () => {}, maxAgentExchanges: 7 });
    views.push(view);
    view.setConfig({ settings: { executionMode: 'agent' } });
    expect(container.querySelector('.llm-input__execution-hint')?.textContent).toContain('7');
    expect(container.querySelector('.llm-input__execution-hint')?.textContent).not.toContain('50');
});

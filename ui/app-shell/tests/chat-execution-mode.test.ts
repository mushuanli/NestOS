// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import { SendMessageCommand } from '../../llm-ui/src/commands/SendMessageCommand';
import { RegenerateCommand } from '../../llm-ui/src/commands/NodeCommands';
import { SessionCommand } from '@itookit/llm-session';
import type { ChatOverrides } from '../../llm-ui/src/domain/types';

const views: ChatInput[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); document.body.innerHTML = ''; });
function fixture() {
    const container = document.createElement('div'); document.body.append(container);
    const onSend = vi.fn(async () => {}), onConfigChange = vi.fn();
    const view = new ChatInput(container, { onSend, onStop: vi.fn(), onConfigChange }); views.push(view);
    const button = (mode: string) => container.querySelector<HTMLButtonElement>(`[data-execution-mode="${mode}"]`)!;
    return { container, view, onSend, onConfigChange, button };
}

it('switches and restores the mode, sends it explicitly, and locks it while running', async () => {
    const f = fixture();
    expect(f.button('chat').getAttribute('aria-pressed')).toBe('true');
    f.button('agent').click();
    expect(f.onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ executionMode: 'agent' }) }));
    expect(f.button('agent').getAttribute('aria-pressed')).toBe('true');
    f.view.setConfig({ text: 'do work' });
    f.container.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledWith('do work', [], 'default', expect.objectContaining({ executionMode: 'agent' })));
    f.view.setLoading(true);
    expect(f.button('chat').disabled).toBe(true);
    f.button('chat').click(); expect(f.view.getConfig().settings.executionMode).toBe('agent');
    f.view.setLoading(false);
    f.view.setConfig({ settings: { executionMode: 'chat' } });
    expect(f.button('chat').getAttribute('aria-pressed')).toBe('true');
});

it('disables the switch for a selected Flow and restores the saved mode after clearing the Flow', () => {
    const f = fixture(); f.button('agent').click();
    f.view.selectFlow('review', 2, {});
    expect(f.button('chat').disabled).toBe(true);
    expect(f.button('agent').disabled).toBe(true);
    expect(f.button('agent').getAttribute('aria-pressed')).toBe('false');
    f.button('chat').click(); expect(f.view.getConfig().settings.executionMode).toBe('agent');
    const input = f.container.querySelector<HTMLInputElement>('.llm-input__flow-id')!;
    input.value = ''; input.dispatchEvent(new Event('input'));
    expect(f.button('agent').disabled).toBe(false);
    expect(f.button('agent').getAttribute('aria-pressed')).toBe('true');
});

it('freezes the send mode before an attachment upload and keeps Flow routing authoritative', async () => {
    let uploaded!: (refs: string[]) => void;
    const execute = vi.fn(async () => undefined);
    const context = { getSessionId: () => 's', commands: { execute },
        chatInput: { setConfig: vi.fn(), setLoading: vi.fn(), restoreInput: vi.fn(), getConfig: () => ({ settings: { executionMode: 'agent' } }) },
        historyView: { scrollToBottom: vi.fn() }, errorHandler: { wrap: (run: () => Promise<unknown>) => run() },
        assetService: { uploadFiles: () => new Promise<string[]>(resolve => { uploaded = resolve; }) },
    };
    const command = new SendMessageCommand(context as never);
    const overrides: ChatOverrides = { executionMode: 'chat' };
    const sending = command.run({ text: 'goal', files: [new File(['text'], 'note.txt')], overrides });
    overrides.executionMode = 'agent';
    await vi.waitFor(() => expect(uploaded).toBeTypeOf('function'));
    uploaded([]); await sending;
    expect(execute).toHaveBeenLastCalledWith(SessionCommand.Send, expect.objectContaining({
        overrides: expect.objectContaining({ executionMode: 'chat' }),
        sendIntent: expect.objectContaining({ execution: { kind: 'agent', agentId: 'default', mode: 'chat' } }),
    }));
    expect(context.chatInput.setConfig).toHaveBeenCalledWith({ settings: { executionMode: 'chat', executionModeLocked: true } });
    await command.run({ text: 'flow', files: [], overrides: { executionMode: 'chat', flowId: 'review', flowRevision: 3 } });
    expect(execute).toHaveBeenLastCalledWith(SessionCommand.Send, expect.objectContaining({ sendIntent: expect.objectContaining({
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

it('keeps the accepted mode locked after stopping and restores the lock on reopening', () => {
    const f = fixture();
    f.view.setConfig({ settings: { executionMode: 'agent', executionModeLocked: true } });
    f.view.setLoading(true); f.view.setLoading(false);
    expect(f.button('chat').disabled).toBe(true);
    expect(f.button('agent').getAttribute('aria-pressed')).toBe('true');
    f.button('chat').click();
    expect(f.view.getConfig().settings.executionMode).toBe('agent');
    expect(f.button('chat').title).toContain('新建会话');
    f.view.setConfig({ settings: { executionMode: 'chat', executionModeLocked: false } });
    expect(f.button('agent').disabled).toBe(false);
});

it('shows the host exchange budget instead of a fixed Agent limit', () => {
    const container = document.createElement('div'); document.body.append(container);
    const view = new ChatInput(container, { onSend: async () => {}, onStop: () => {}, maxAgentExchanges: 7 });
    views.push(view);
    view.setConfig({ settings: { executionMode: 'agent' } });
    expect(container.querySelector('.llm-input__execution-hint')?.textContent).toContain('7');
    expect(container.querySelector('.llm-input__execution-hint')?.textContent).not.toContain('50');
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SessionCommand } from '@itookit/llm-session';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import { buildSlashCallbacks } from '../../llm-ui/src/shell/SlashCommandRouter';
import { SlashCommandPlugin } from '../../llm-ui/src/components/input/plugins/SlashCommandPlugin';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('opens the picker, persists a Session selection, resets to default, and rejects invalid ids', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const view = new ChatInput(container, {} as never);
    const execute = vi.fn(async () => {}), open = vi.spyOn(view, 'openConnectionPicker');
    const callbacks = buildSlashCallbacks({ chatInput: view, commands: { execute }, bus: { emit: vi.fn() },
        agentService: { getConnection: async (id: string) => id === 'chosen' ? { id, providerId: 'p' } : null,
            getProvider: () => ({ enabled: true }) },
    } as never);
    view.registerPlugin(new SlashCommandPlugin(callbacks));
    try {
        await callbacks.onConnection!(''); expect(open).toHaveBeenCalledOnce();
        await callbacks.onConnection!('chosen');
        expect(execute).toHaveBeenLastCalledWith(SessionCommand.SaveSettings, { connectionId: 'chosen' });
        expect(view.getConfig().settings?.connectionId).toBe('chosen');
        await expect(callbacks.onConnection!('missing')).rejects.toThrow();
        expect(view.getConfig().settings?.connectionId).toBe('chosen');
        await callbacks.onConnection!('--reset');
        expect(execute).toHaveBeenLastCalledWith(SessionCommand.SaveSettings, { connectionId: undefined });
        expect(view.getConfig().settings?.connectionId).toBeUndefined();
    } finally { view.destroy(); }
});

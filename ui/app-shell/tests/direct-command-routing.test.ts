// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { SessionCommand } from '@itookit/llm-session';
import { SendMessageCommand } from '../../llm-ui/src/commands/SendMessageCommand';
import { RegenerateCommand, EditAndRetryCommand } from '../../llm-ui/src/commands/NodeCommands';
import { rerunSession } from '../../llm-ui/src/shell/rerun-session';

function fixture(text = '!ls') {
    const user = { id: 'user', role: 'user', content: text, persistedNodeId: 'round' };
    const assistant = { id: 'assistant', role: 'assistant', parentUserSessionId: 'user', persistedNodeId: 'round' };
    const execute = vi.fn(async (name: string) => {
        if (name === SessionCommand.GetSessions) return [user, assistant];
        if (name === SessionCommand.CanRegenerate) return { allowed: true };
        if (name === SessionCommand.GetCurrentId) return 'session';
        if (name === SessionCommand.FlowRerunContext) return null;
    });
    const ctx: any = { commands: { execute }, executeDirectCommand: vi.fn(async () => {}), resolveSubmission: vi.fn(),
        chatInput: { restoreInput: vi.fn(), setLoading: vi.fn(), getConfig: () => ({ settings: {}, agentId: 'default' }) },
        errorHandler: { wrap: (fn: () => Promise<unknown>) => fn() } };
    return { ctx, execute };
}

it('routes send through the shared command policy before resolving an LLM submission', async () => {
    const { ctx, execute } = fixture();
    expect(await new SendMessageCommand(ctx).run({ text: '!ls', files: [] })).toBe(true);
    expect(ctx.executeDirectCommand).toHaveBeenCalledWith('ls');
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.resolveSubmission).not.toHaveBeenCalled();
});

it.each(['user', 'assistant'])('routes %s resend through exec and preserves existing history', async nodeId => {
    const { ctx, execute } = fixture();
    await new RegenerateCommand(ctx).run({ nodeId });
    expect(ctx.executeDirectCommand).toHaveBeenCalledWith('ls');
    expect(execute.mock.calls.map(call => call[0])).toEqual([SessionCommand.GetSessions, SessionCommand.CanRegenerate]);
    expect(ctx.chatInput.setLoading).not.toHaveBeenCalled();
});

it('keeps ordinary resend on the existing branch-producing command', async () => {
    const { ctx, execute } = fixture('Explain these files');
    await new RegenerateCommand(ctx).run({ nodeId: 'user' });
    expect(ctx.executeDirectCommand).not.toHaveBeenCalled();
    expect(execute.mock.calls.at(-1)?.[0]).toBe(SessionCommand.RegenerateFromUser);
});

it('never falls back to the model when send or resend lacks exec capability', async () => {
    const { ctx, execute } = fixture(); ctx.executeDirectCommand = undefined;
    await expect(new SendMessageCommand(ctx).run({ text: '!ls', files: [] })).rejects.toThrow();
    expect(ctx.chatInput.restoreInput).toHaveBeenCalledWith('!ls', undefined);
    await expect(new RegenerateCommand(ctx).run({ nodeId: 'user' })).rejects.toThrow();
    expect(execute.mock.calls.map(call => call[0])).not.toContain(SessionCommand.RegenerateFromUser);
});

it('saves edited commands without automatically invoking the model', async () => {
    const { ctx, execute } = fixture();
    await new EditAndRetryCommand(ctx).run({ nodeId: 'user' });
    expect(execute).toHaveBeenCalledWith(SessionCommand.CommitEdit, { messageId: 'user', newContent: '!ls', autoRerun: false });
    expect(ctx.executeDirectCommand).toHaveBeenCalledWith('ls');
});

it('uses the same input policy for the session rerun menu', async () => {
    const { ctx, execute } = fixture();
    await rerunSession(ctx.commands, 'session', 'chat', new AbortController().signal, ctx.executeDirectCommand);
    expect(ctx.executeDirectCommand).toHaveBeenCalledWith('ls');
    expect(execute.mock.calls.map(call => call[0])).not.toContain(SessionCommand.RegenerateFromUser);
});

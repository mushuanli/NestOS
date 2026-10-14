// @vitest-environment jsdom
/**
 * P0-02 应用层失败闭环：发送被拒（IPC/内核错误、授权失败、附件上传失败）时，
 * UI 状态与持久状态必须一致——输入恢复、加载态复位、错误可见，不能误删已受理轮次。
 *
 * jsdom 环境由 app-shell 提供（llm-ui 的 vitest 无 jsdom）；被测对象是真实
 * `SendMessageCommand`，命令总线与展示端口是记录型替身。
 */
import { expect, it, vi } from 'vitest';
import { Toast } from '@itookit/ui-common';
import { SessionCommand } from '@itookit/llm-session';
import { SendMessageCommand } from '../../llm-ui/src/commands/SendMessageCommand';
import type { CommandContext } from '../../llm-ui/src/commands/CommandContext';

interface HarnessOptions {
    sendError?: Error;
    ghosts?: string[];
    uploadError?: Error;
    /** Throw from GetSessions once this many calls have been made (the rollback transport is down). */
    sessionsErrorAfter?: number;
    deleteError?: Error;
}

function harness(options: HarnessOptions = {}) {
    const sessions = ['session-one'];
    let sessionCalls = 0;
    const execute = vi.fn(async (command: string, payload?: any) => {
        if (command === SessionCommand.GetSessions) {
            sessionCalls++;
            if (options.sessionsErrorAfter !== undefined && sessionCalls > options.sessionsErrorAfter) throw new Error('IPC connection lost');
            return sessions.map(id => ({ id }));
        }
        if (command === SessionCommand.Send) {
            // The round projection is already persisted when the transport fails.
            sessions.push(...(options.ghosts ?? []));
            throw options.sendError ?? new Error('IPC connection lost');
        }
        if (command === SessionCommand.DeleteMessage) {
            if (options.deleteError) throw options.deleteError;
            const index = sessions.indexOf(payload.messageId);
            if (index >= 0) sessions.splice(index, 1);
            return;
        }
        throw new Error(`Unexpected command ${command}`);
    });
    const chatInput = { setLoading: vi.fn(), restoreInput: vi.fn(), scrollToBottom: vi.fn() };
    const historyView = { scrollToBottom: vi.fn(), renderError: vi.fn(), removeMessages: vi.fn(() => []) };
    const uploadFiles = vi.fn(async () => { if (options.uploadError) throw options.uploadError; return ['attachment://one']; });
    const ctx = {
        getSessionId: () => 'session-one',
        commands: { execute },
        chatInput, historyView,
        assetService: { uploadFiles },
        errorHandler: { wrap: (fn: () => Promise<unknown>) => fn() },
    } as unknown as CommandContext;
    return { ctx, execute, chatInput, historyView, uploadFiles, sessions };
}

it('preserves accepted rounds when the send response is lost', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const { ctx, execute, chatInput, historyView, sessions } = harness({ ghosts: ['accepted-user', 'accepted-assistant'] });
        await new SendMessageCommand(ctx).run({ text: 'hello', files: [], agentId: 'default' });
        expect(chatInput.restoreInput).toHaveBeenCalledWith('hello', 'default');
        expect(chatInput.setLoading).toHaveBeenLastCalledWith(false);
        expect(toast).toHaveBeenCalled();
        expect(historyView.removeMessages).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalledWith(SessionCommand.DeleteMessage, expect.anything());
        expect(sessions).toEqual(['session-one', 'accepted-user', 'accepted-assistant']);
    } finally { toast.mockRestore(); }
});

it('restores the draft even when history queries are unavailable', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const { ctx, execute, chatInput } = harness({ sessionsErrorAfter: 0 });
        await new SendMessageCommand(ctx).run({ text: 'offline draft', files: [], agentId: 'default' });
        expect(chatInput.restoreInput).toHaveBeenCalledWith('offline draft', 'default');
        expect(chatInput.setLoading).toHaveBeenLastCalledWith(false);
        expect(execute).not.toHaveBeenCalledWith(SessionCommand.GetSessions);
        expect(toast).toHaveBeenCalled();
    } finally { toast.mockRestore(); }
});

it('renders an authorization failure without deleting durable history', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const { ctx, chatInput, historyView, sessions } = harness({ sendError: new Error('401 Unauthorized'), ghosts: ['accepted-user'] });
        await new SendMessageCommand(ctx).run({ text: 'hello', files: [] });
        expect(historyView.renderError).toHaveBeenCalledWith(expect.objectContaining({ message: '401 Unauthorized' }));
        expect(chatInput.restoreInput).toHaveBeenCalledWith('hello', undefined);
        expect(historyView.removeMessages).not.toHaveBeenCalled();
        expect(sessions).toContain('accepted-user');
    } finally { toast.mockRestore(); }
});

it('keeps the draft and sends nothing when an attachment upload fails', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const { ctx, execute, chatInput, sessions } = harness({ uploadError: new Error('upload rejected') });
        await new SendMessageCommand(ctx).run({ text: 'hello', files: [new File(['x'], 'x.txt')], agentId: 'default' });
        expect(toast).toHaveBeenCalledWith('upload rejected');
        expect(chatInput.restoreInput).toHaveBeenCalledWith('hello', 'default');
        expect(chatInput.setLoading).toHaveBeenLastCalledWith(false);
        expect(execute).not.toHaveBeenCalledWith(SessionCommand.Send, expect.anything());
        expect(sessions).toEqual(['session-one']);
    } finally { toast.mockRestore(); }
});

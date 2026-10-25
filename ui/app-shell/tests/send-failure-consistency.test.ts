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
import { SendMessageCommand } from '../../llm-ui-adapter/src/commands/SendMessageCommand';
import type { CommandContext } from '../../llm-ui-adapter/src/commands/CommandContext';
import {sha256Hex} from '@itookit/llm-context/digest';

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
    const historyView = { scrollToBottom: vi.fn(), renderError: vi.fn(), removeMessages: vi.fn(() => []), setSubmission: vi.fn() };
    const uploadFiles = vi.fn(async () => { if (options.uploadError) throw options.uploadError; return ['attachment://one']; });
    const ctx = {
        getSessionId: () => 'session-one',
        commands: { execute },
        isGenerating: () => false,
        chatInput, historyView,
        assetService: { prepareUpload: async () => ({references: await uploadFiles(), files: []}) },
        errorHandler: { wrap: (fn: () => Promise<unknown>) => fn() },
    } as unknown as CommandContext;
    return { ctx, execute, chatInput, historyView, uploadFiles, sessions };
}

it('sends prepared Flow files only through structured arguments instead of uploading chat attachments again', async () => {
    const f = harness(), data = new TextEncoder().encode('Selected file'), file = new File([data], 'notes.txt', {type: 'text/plain'});
    f.execute.mockImplementation(async name => name === SessionCommand.Send ? 'accepted' : {items: []});
    const parameters = {documents: [{type: 'file', name: file.name, source: {type: 'asset', asset: {kind: 'input',
        id: '12345678-1234-4123-8123-123456789abc', mimeType: file.type, bytes: file.size, sha256: await sha256Hex(data)}}}]};
    expect(await new SendMessageCommand(f.ctx).run({text: '', files: [file], overrides: {flowParameters: parameters,
        flowExpectedSignature: {id: 'flow' as never, revision: 1, digest: 'published'}}})).toBe(true);
    expect(f.uploadFiles).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Send, expect.objectContaining({text: '', files: [], overrides: expect.objectContaining({flowParameters: parameters})}));
});

it('preserves an unbound Flow attachment and refuses submission before any chat upload or send', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const f = harness(), file = new File(['Selected file'], 'notes.txt', {type: 'text/plain'});
        expect(await new SendMessageCommand(f.ctx).run({text: 'Keep draft', files: [file], overrides: {flowParameters: {},
            flowExpectedSignature: {id: 'flow' as never, revision: 1, digest: 'published'}}})).toBe(false);
        expect(f.execute).not.toHaveBeenCalled(); expect(f.uploadFiles).not.toHaveBeenCalled();
        expect(f.chatInput.restoreInput).toHaveBeenCalledWith('Keep draft', undefined);
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('附件'));
    } finally {toast.mockRestore();}
});

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

it('keeps the current execution controls active when enqueueing the next instruction fails', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const f = harness(); f.ctx.isGenerating = () => true;
        await new SendMessageCommand(f.ctx).run({ text: 'Keep this queued draft', files: [] });
        expect(f.chatInput.setLoading).toHaveBeenLastCalledWith(true);
        expect(f.chatInput.restoreInput).toHaveBeenCalledWith('Keep this queued draft', undefined);
    } finally { toast.mockRestore(); }
});

it('reuses submission identity and uploaded references when retrying an unknown queued submission', async () => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const f = harness({ sendError: Object.assign(new Error('Response lost'), { outcome: 'unknown' }) });
        const command = new SendMessageCommand(f.ctx), files = [new File(['attachment'], 'one.txt')];
        await command.run({ text: 'queued request', files });
        const original = f.execute.mock.calls.find(([name]) => name === SessionCommand.Send)![1];
        f.execute.mockImplementation(async (name: string) => name === SessionCommand.Send ? original.sendIntent.submission.id
            : { sessionId: 'session-one', revision: 1, paused: false, items: [{ id: original.sendIntent.submission.id }] });
        await command.run({ text: 'queued request', files });
        const sends = f.execute.mock.calls.filter(([name]) => name === SessionCommand.Send);
        expect(sends[1][1].sendIntent.submission).toEqual(original.sendIntent.submission);
        expect(sends[1][1].text).toBe(original.text);
        expect(f.uploadFiles).toHaveBeenCalledOnce();
        expect(f.historyView.setSubmission).toHaveBeenLastCalledWith();
    } finally { toast.mockRestore(); }
});

it('uses the host state when completion arrives before the send receipt returns', async () => {
    const {ctx, execute, chatInput} = harness();
    execute.mockImplementation(async () => 'completed-task');
    ctx.isGenerating = () => false;
    await new SendMessageCommand(ctx).run({text: 'Fast result', files: []});
    expect(chatInput.setLoading).toHaveBeenLastCalledWith(false);
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


it('presents the local user message before attachment upload and correlates the accepted round explicitly', async () => {
    const {ctx, historyView, uploadFiles, execute} = harness();
    let finishUpload!: (refs: string[]) => void;
    uploadFiles.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    execute.mockImplementation(async () => 'accepted-task');
    const sending = new SendMessageCommand(ctx).run({text: 'local prompt', files: [new File(['x'], 'x.txt')]});
    await vi.waitFor(() => expect(uploadFiles).toHaveBeenCalledOnce());
    expect(historyView.setSubmission).toHaveBeenLastCalledWith(expect.objectContaining({text: 'local prompt', state: 'submitting'}));
    expect(execute).not.toHaveBeenCalled();
    finishUpload(['attachment://one']); await sending;
    const submitted = execute.mock.calls.find(([command]) => command === SessionCommand.Send)![1].sendIntent.submission;
    expect(historyView.setSubmission).toHaveBeenLastCalledWith(expect.objectContaining({state: 'accepted', messageId: `round-${submitted.id}-user`}));
});

it.each(['Later draft', ''])('does not restore rejected text over a newer edit %j', async newer => {
    const toast = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    try {
        const {ctx, execute, chatInput} = harness();
        let reject!: (error: Error) => void;
        let draft = 'Submitted';
        Object.assign(chatInput, {getConfig: () => ({text: draft, settings: {}})});
        execute.mockImplementationOnce(() => new Promise((_, fail) => {reject = fail;}));
        const pending = new SendMessageCommand(ctx).run({text: 'Submitted', files: []});
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        draft = newer; reject(new Error('Rejected')); await pending;
        expect(chatInput.restoreInput).not.toHaveBeenCalled();
    } finally { toast.mockRestore(); }
});

it.each(['missing', 'throws'])('sends and projects feedback through the internal UUID helper when native UUID %s', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('Unavailable native UUID');}} : {})});
    try {
        const {ctx, execute, historyView} = harness(); execute.mockResolvedValue('task');
        await new SendMessageCommand(ctx).run({text: 'Compatible send', files: []});
        expect(execute).toHaveBeenCalledWith(SessionCommand.Send, expect.anything());
        expect(historyView.setSubmission).toHaveBeenCalledWith(expect.objectContaining({id: expect.stringMatching(/^[\da-f]{8}-[\da-f-]{27}$/i)}));
    } finally {vi.unstubAllGlobals();}
});

// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { ExecProgram } from '@itookit/kernel-adapters';
import type { IAgentConfigService } from '@itookit/llm-session';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { PrivilegedCommandService } from '../../../backend/app-core/src/kernel/privileged-command-service';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import { RunAttachmentController } from '../../llm-ui/src/shell/RunAttachmentController';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';

it.each([true, false])('restores an exec approval card and preserves the real effect boundary (%s)', async approved => {
    const f = await fixture();
    try {
        const service = new PrivilegedCommandService(f.kernel, {} as IAgentConfigService);
        const id = await service.exec({ sessionId: 'session', command: 'inspect' });
        const task = await f.session.attachTask(id);
        await vi.waitFor(async () => expect((await task.status()).task.interactions['approve:exec']?.status).toBe('pending'));
        await f.controller.attach(id);
        await vi.waitFor(() => expect(f.container.querySelector('.llm-input__interaction')).not.toBeNull());
        expect(f.execute).not.toHaveBeenCalled();
        await f.controller.detach();
        expect(f.container.querySelector('.llm-input__interaction')).toBeNull();
        await f.controller.attach(id);
        await vi.waitFor(() => expect(f.container.querySelector('.llm-input__interaction')).not.toBeNull());
        f.container.querySelector<HTMLTextAreaElement>('.llm-input__interaction-input')!.value = 'UI reviewed';
        f.container.querySelector<HTMLButtonElement>(`[data-interaction-action="${approved ? 'approve' : 'reject'}"]`)!.click();
        expect((await task.wait({ timeoutMs: 5000 })).status).toBe(approved ? 'succeeded' : 'failed');
        expect(f.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
        await vi.waitFor(() => expect(f.container.querySelector('.llm-input__interaction')).toBeNull());
    } finally { await f.dispose(); }
});

async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session/.kernel' }; } });
    kernel.registerProgram(new ExecProgram());
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: 'inspected' }));
    kernel.registerEffect({ kind: 'process.exec', version: '1', execute });
    await kernel.initialize();
    const session = await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
    const container = document.createElement('div'); document.body.append(container);
    const input = new ChatInput(container, { onSend: async () => {}, onStop: () => {} });
    const editor: any = { chatInput: input, currentSessionId: 'session', showFlowInput: () => false };
    const controller = new RunAttachmentController(kernel, {
        onEvent: () => {}, onWaiting: request => (LLMWorkspaceEditor.prototype as any).handleRunWaiting.call(editor, request),
        onDetached: () => input.clearInteraction(),
    });
    editor.runAttachment = controller;
    return { kernel, session, execute, controller, container, async dispose() {
        await controller.detach(); input.destroy(); container.remove();
        await kernel.dispose(); await kernel.waitIdle(); await manager.dispose();
    } };
}

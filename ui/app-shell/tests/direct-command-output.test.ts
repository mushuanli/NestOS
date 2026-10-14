// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';

/** The editor only adapts a task record to the inline panel; Kernel I/O is out of scope here. */
function fixture(task: unknown) {
    const showToolOutput = vi.fn(), update = vi.fn(), clearInteraction = vi.fn();
    const instance: any = Object.create(LLMWorkspaceEditor.prototype);
    Object.assign(instance, { chatInput: { showToolOutput, clearInteraction }, statusIndicator: { update },
        runAttachment: { current: async () => task } });
    const fire = (type: string) => instance.handleRunEvent({ type, sequence: 1, sessionId: 'session', occurredAt: 0 });
    return { fire, showToolOutput, update, clearInteraction };
}

const execTask = (status: string, exit?: unknown) =>
    ({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'ls' }, status, exit });

it('shows the approved command stdout that the process actually returned', async () => {
    const f = fixture(execTask('succeeded', { output: { result: { output: '[exit 0]\nfile.txt\n', data: { exitCode: 0 } } } }));
    f.fire('task.succeeded');
    await vi.waitFor(() => expect(f.showToolOutput).toHaveBeenCalledWith('ls', '[exit 0]\nfile.txt\n', true));
    expect(f.clearInteraction).toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith('completed');
});

it('keeps a non-zero exit visible as a failure with its output', async () => {
    const f = fixture(execTask('succeeded', { output: { result: { output: '[exit 1]\n', data: { exitCode: 1 } } } }));
    f.fire('task.succeeded');
    await vi.waitFor(() => expect(f.showToolOutput).toHaveBeenCalledWith('ls', '[exit 1]\n', false));
});

it('reports a failed effect instead of leaving the approval result invisible', async () => {
    const f = fixture(execTask('failed', { error: { message: 'Execution backend unavailable' } }));
    f.fire('task.failed');
    await vi.waitFor(() => expect(f.showToolOutput).toHaveBeenCalledWith('ls', 'Execution backend unavailable', false));
});

it('falls back to localized copy when a cancelled command has no output', async () => {
    const f = fixture(execTask('cancelled'));
    f.fire('task.cancelled');
    await vi.waitFor(() => expect(f.showToolOutput).toHaveBeenCalledWith('ls', t('chatInput.command.cancelled'), false));
});

it('leaves plan and flow tasks to their own presenters', async () => {
    const f = fixture({ program: { kind: 'llm.plan' }, input: { goal: 'inspect' }, status: 'succeeded' });
    f.fire('task.succeeded');
    await Promise.resolve();
    expect(f.showToolOutput).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith('completed');
});

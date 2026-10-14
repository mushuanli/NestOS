// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionCommand } from '@itookit/llm-session';
import { rerunSession } from '../../llm-ui/src/shell/rerun-session';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

function fixture() {
    const responses = new Map<string, unknown>([
        [SessionCommand.FlowRerunContext, null], [SessionCommand.GetCurrentId, 's'],
        [SessionCommand.GetSessions, [{ id: 'old', role: 'user' }, { id: 'latest', role: 'user' }, { id: 'answer', role: 'assistant' }]],
        [SessionCommand.CanRegenerate, { allowed: true }],
    ]);
    const execute = vi.fn(async (command: string, _args?: unknown) => responses.get(command));
    const abort = new AbortController();
    return { responses, execute, abort, run: () => rerunSession({ execute } as never, 's', 'agent', abort.signal) };
}

it('reruns the latest user request in Harness mode without invoking Flow commands', async () => {
    const f = fixture();
    f.responses.set(SessionCommand.GetConnections, { connections: [] }); await f.run();
    expect(f.execute).toHaveBeenLastCalledWith(SessionCommand.RegenerateFromUser, {
        userMessageId: 'latest', options: { overrides: { executionMode: 'agent' } },
    });
    expect(f.execute.mock.calls.some(([command]) => command === SessionCommand.FlowRerun)).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
});

it('retains the Flow parameter form and does not regenerate its setup message as a chat', async () => {
    const f = fixture();
    f.responses.set(SessionCommand.GetConnections, { connections: [] });
    f.responses.set(SessionCommand.FlowRerunContext, { sessionId: 's', sourceRoundId: 'r', definitionKey: 'key',
        flow: { parameters: { goal: 'saved' } }, definition: { parameters: [{ name: 'goal', type: 'string' }] } });
    const pending = f.run();
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe('saved'));
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await pending;
    expect(f.execute).toHaveBeenLastCalledWith(SessionCommand.FlowRerun, {
        sessionId: 's', sourceRoundId: 'r', definitionKey: 'key', parameters: { goal: 'saved' },
    });
    expect(f.execute.mock.calls.some(([command]) => command === SessionCommand.RegenerateFromUser)).toBe(false);
});

it.each(['empty', 'busy', 'switched', 'aborted'] as const)('does not submit when the branch is %s', async reason => {
    const f = fixture();
    f.responses.set(SessionCommand.GetConnections, { connections: [] });
    if (reason === 'empty') f.responses.set(SessionCommand.GetSessions, []);
    if (reason === 'busy') f.responses.set(SessionCommand.CanRegenerate, { allowed: false, reason: 'busy' });
    if (reason === 'switched') f.responses.set(SessionCommand.GetCurrentId, 'other');
    if (reason === 'aborted') {
        f.execute.mockImplementation(async command => {
            if (command === SessionCommand.CanRegenerate) f.abort.abort();
            return f.responses.get(command);
        });
    }
    if (reason === 'empty' || reason === 'busy') await expect(f.run()).rejects.toThrow();
    else await f.run();
    expect(f.execute.mock.calls.some(([command]) => command === SessionCommand.RegenerateFromUser)).toBe(false);
});

it('deduplicates editor reruns before admission and captures the selected mode', async () => {
    const f = fixture();
    f.responses.set(SessionCommand.GetConnections, { connections: [] });
    let release!: () => void;
    f.execute.mockImplementation(async command => {
        if (command === SessionCommand.FlowRerunContext) await new Promise<void>(resolve => { release = resolve; });
        return f.responses.get(command);
    });
    const settings = { executionMode: 'agent' };
    const editor = { options: {}, currentSessionId: 's', rerunPending: false, sessionManager: { isGenerating: () => false },
        commandBus: { execute: f.execute }, chatInput: { getConfig: () => ({ settings }) } };
    const run = () => (LLMWorkspaceEditor.prototype as any).rerunSession.call(editor);
    const first = run(); await run();
    settings.executionMode = 'chat'; release(); await first;
    expect(f.execute.mock.calls.filter(([command]) => command === SessionCommand.RegenerateFromUser)).toEqual([
        [SessionCommand.RegenerateFromUser, { userMessageId: 'latest', options: { overrides: { executionMode: 'agent' } } }],
    ]);
    expect(editor.rerunPending).toBe(false);
});

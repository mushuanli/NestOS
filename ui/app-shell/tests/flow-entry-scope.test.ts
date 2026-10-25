// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {LLMWorkspaceEditor} from '../../llm-ui-adapter/src/shell/LLMWorkspaceEditor';
import {invokeFlowText} from '../../llm-ui-adapter/src/flows/invoke-flow';
vi.mock('../../llm-ui-adapter/src/flows/invoke-flow', () => ({invokeFlowText: vi.fn()}));

it.each([true, false])('expires the old branch form before restoring drafts (visible=%s)', async visible => {
    // Exercise editor event wiring without constructing unrelated rendering services.
    const editor = Object.create(LLMWorkspaceEditor.prototype) as any;
    let event!: (event: unknown) => void, finish!: (accepted: boolean) => void;
    const original = new AbortController();
    const switchDraftBranch = vi.fn(async () => {expect(original.signal.aborted).toBe(true);});
    Object.assign(editor, {options: {sessionId: 's'}, viewActive: true, invocationAbort: original,
        stateManager: {switchDraftBranch}, sessionEventHandler: {handleSessionEvent: vi.fn()},
        sessionManager: {onEvent: (callback: typeof event) => {event = callback; return vi.fn();}}});
    vi.mocked(invokeFlowText).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    editor.bindSessionEvents(); const pending = editor.startFlowInvocation('f');
    editor.viewActive = visible; event({type: 'branch:switched', payload: {branchName: 'b'}});
    expect(switchDraftBranch).toHaveBeenCalledWith('b');
    expect(editor.invocationAbort.signal.aborted).toBe(!visible);
    expect(vi.mocked(invokeFlowText).mock.calls.at(-1)?.[3]).toBe(original.signal);
    finish(true); expect(await pending).toBe(false);
    expect(editor.invocationPending).toBeUndefined();
});

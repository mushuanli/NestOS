// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallView, type ICommandBus, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {IndependentCallPanel} from '../../llm-ui-adapter/src/components/IndependentCallPanel';
import {submitSessionCall} from '../../llm-ui-adapter/src/commands/submit-session-call';
import type {CommandContext} from '../../llm-ui-adapter/src/commands/CommandContext';

let panel: IndependentCallPanel | undefined;
afterEach(() => {panel?.destroy(); panel = undefined; vi.useRealTimers(); document.body.replaceChildren();});
const request: SubmissionRequest = {expectedSessionId: 'parent', expectedBranch: 'main', target: {kind: 'flow', id: 'worker', version: '1'},
    expectedTarget: {kind: 'flow', id: 'worker', version: '1', digest: 'published'}, source: {kind: 'arguments', value: {count: 3}},
    submission: {id: 'call', source: {kind: 'conversation', ownerId: 'parent', id: 'call'}}};
const view = (): IndependentCallView => ({input: {request: structuredClone(request), title: 'Worker'}, createdAt: 1, head: null,
    receipt: {operationId: 'call', callerSessionId: 'parent', status: 'accepted', executionSessionId: 'child'}, status: 'completed', summary: '<unsafe>Done</unsafe>'});

it('releases a suspended submit through matching durable admission and opens the actual child', async () => {
    const operations = createOperationLedger(), openChild = vi.fn();
    const execute = vi.fn(async (command: string) => {
        if (command === IndependentCallCommand.Submit) return new Promise(() => {});
        if (command === IndependentCallCommand.List) return [view()];
        throw new Error(command);
    });
    const commands = {execute} as unknown as ICommandBus;
    const ctx = {operations, commands, getSessionId: () => 'parent', observeInstructions: vi.fn(() => () => {}), reconcileSubmission: vi.fn()} as unknown as CommandContext;
    const sending = submitSessionCall(ctx, request, 'key', undefined, undefined, 'Worker');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(IndependentCallCommand.Submit, {request, title: 'Worker'}));
    panel = new IndependentCallPanel(commands, 'parent', document.body, {operations, branch: () => 'main', openChild});
    await panel.refresh(); expect(await sending).toBe('call');
    expect(ctx.observeInstructions).not.toHaveBeenCalled(); expect(ctx.reconcileSubmission).not.toHaveBeenCalled();
    expect(document.querySelector('[data-output]')!.textContent).toBe('<unsafe>Done</unsafe>'); expect(document.querySelector('unsafe')).toBeNull();
    document.querySelector('button')!.click(); expect(openChild).toHaveBeenCalledWith('child');
    expect(execute.mock.calls.filter(([command]) => command === IndependentCallCommand.Submit)).toHaveLength(1);
});

it.each(['request', 'title', 'scope'])('does not accept a mismatching %s projection', async change => {
    const operations = createOperationLedger();
    await operations.register({context: {viewId: 'parent', operationId: 'call'}, conversationId: 'parent', kind: 'send', status: 'unknown',
        input: JSON.parse(JSON.stringify({request, independentTitle: 'Worker'}))});
    const call = view();
    if (change === 'request') call.input.request.source = {kind: 'arguments', value: {count: 4}};
    if (change === 'title') call.input.title = 'Another';
    if (change === 'scope') call.receipt.callerSessionId = 'other';
    panel = new IndependentCallPanel({execute: vi.fn(async () => [call])} as unknown as ICommandBus, 'parent', document.body,
        {operations, branch: () => 'main', openChild() {}});
    await panel.refresh(); expect(operations.getSnapshot()[0].status).toBe('unknown');
    if (change === 'scope') expect(document.querySelector('[data-independent-call]')).toBeNull();
});

it.each(['hidden', 'destroyed', 'branch'])('discards a late query after the view becomes %s', async change => {
    let finish!: (calls: IndependentCallView[]) => void, branch = 'main';
    const execute = vi.fn(() => new Promise<IndependentCallView[]>(resolve => {finish = resolve;}));
    panel = new IndependentCallPanel({execute} as unknown as ICommandBus, 'parent', document.body,
        {operations: createOperationLedger(), branch: () => branch, openChild() {}});
    const reading = panel.refresh(), finishOriginal = finish;
    if (change === 'hidden') panel.setVisible(false);
    if (change === 'destroyed') panel.destroy();
    if (change === 'branch') {branch = 'next'; panel.reset();}
    finishOriginal([view()]); await reading;
    expect(document.querySelector('[data-independent-call]')).toBeNull();
});

it('uses the shared parameter preparation and preserves newer input while independent submission is pending', async () => {
    const {ChatInput} = await import('../../llm-ui-adapter/src/components/input/ChatInputView');
    const target = request.expectedTarget!;
    let finish!: () => void;
    const onSend = vi.fn(async () => {}), independent = vi.fn(() => new Promise<void>(resolve => {finish = resolve;}));
    const prepareCallTarget = vi.fn(async () => ({flowParameters: {count: 3}, flowExpectedSignature: {id: 'worker', revision: 1, digest: 'published'}}));
    const input = new ChatInput(document.body, {initialConfig: {target, agentId: ''}, onSend, onIndependentSend: independent, onStop() {},
        requestCallTargets: async () => ({entries: [{target, name: 'Worker'}], issues: []}), prepareCallTarget});
    try {
        await input.refreshCallTargets();
        document.querySelector<HTMLButtonElement>('[data-independent-call]')!.click();
        await vi.waitFor(() => expect(independent).toHaveBeenCalledOnce());
        expect(prepareCallTarget).toHaveBeenCalledOnce(); expect(onSend).not.toHaveBeenCalled();
        expect(independent.mock.calls[0]).toEqual(['', [], '', expect.objectContaining({flowParameters: {count: 3}}), target]);
        input.setConfig({text: 'Newer draft'}); finish();
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-independent-call]')!.disabled).toBe(false));
        expect(input.getConfig().text).toBe('Newer draft');
        document.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
        await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
        expect(independent).toHaveBeenCalledOnce();
    } finally {input.destroy();}
});

it('polls completed calls slowly and releases observation on hide and destroy', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => [view()]);
    panel = new IndependentCallPanel({execute} as unknown as ICommandBus, 'parent', document.body,
        {operations: createOperationLedger(), branch: () => 'main', openChild() {}});
    await panel.refresh(); expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_000); expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(execute).toHaveBeenCalledTimes(2);
    panel.setVisible(false); await vi.advanceTimersByTimeAsync(60_000); expect(execute).toHaveBeenCalledTimes(2);
    panel.setVisible(true); await panel.refresh(); expect(execute).toHaveBeenCalledTimes(3);
    panel.destroy(); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(60_000); expect(execute).toHaveBeenCalledTimes(3);
});

it('starts a fresh observation after reopening even if the old query never resolves', async () => {
    const execute = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue([view()]);
    panel = new IndependentCallPanel({execute} as unknown as ICommandBus, 'parent', document.body,
        {operations: createOperationLedger(), branch: () => 'main', openChild() {}});
    panel.setVisible(false); panel.setVisible(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await panel.refresh(); expect(document.querySelector('[data-independent-call]')).not.toBeNull();
});

// @vitest-environment jsdom
import {ArtifactCommand} from '@itookit/app-contracts';
import {sha256Hex} from '@itookit/common';
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
    document.querySelector<HTMLButtonElement>('[data-open-child]')!.click(); expect(openChild).toHaveBeenCalledWith('child');
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


async function artifactFixture() {
    const call = view(); call.receipt.execution = {role: 'primary', taskId: 'actual-task'};
    const data = new TextEncoder().encode('<script>child output</script>'), sha256 = await sha256Hex(data);
    const reference = {kind: 'task-output', sessionId: 'child', taskId: 'actual-task', artifactId: 'report'};
    const page = {sessionId: 'child', taskId: 'actual-task', items: [{reference, taskId: 'actual-task', outputName: 'report',
        name: 'report.txt', kind: 'text', mimeType: 'text/plain', bytes: data.length, sha256}]};
    const execute = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
        if (command === IndependentCallCommand.List) return [call];
        if (command === ArtifactCommand.List) return page;
        if (command === ArtifactCommand.Read) return {reference, offset: 0, totalBytes: data.length, mimeType: 'text/plain', sha256, data: new Uint8Array(data).buffer};
        throw new Error(command);
    });
    const operations = createOperationLedger();
    panel = new IndependentCallPanel({execute} as unknown as ICommandBus, 'parent', document.body,
        {operations, branch: () => 'main', openChild() {}});
    await panel.refresh(); return {call, execute, page, operations};
}

it('reads child artifacts on demand and keeps previews through parent-card polling', async () => {
    const f = await artifactFixture();
    expect(f.execute.mock.calls.filter(([command]) => command === IndependentCallCommand.List)).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-artifact-preview]')).not.toBeNull());
    expect(f.execute).toHaveBeenCalledWith(ArtifactCommand.List, {sessionId: 'child', taskId: 'actual-task', offset: 0, limit: 20});
    document.querySelector<HTMLButtonElement>('[data-artifact-preview]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-artifacts] pre')?.textContent).toBe('<script>child output</script>'));
    const preview = document.querySelector('[data-artifacts] pre');
    await panel!.refresh();
    expect(document.querySelector('[data-artifacts] pre')).toBe(preview);
    expect(document.querySelector('script')).toBeNull();
    expect(f.execute.mock.calls.filter(([command]) => command === ArtifactCommand.Read)).toHaveLength(1);
    expect(f.operations.getSnapshot()).toEqual([]);
});

it.each(['hidden', 'destroyed', 'reset'])('discards an outstanding artifact catalog after the parent card is %s', async state => {
    const f = await artifactFixture(), real = f.execute.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    f.execute.mockImplementation((command, args) => command === ArtifactCommand.List ? new Promise(resolve => {finish = resolve;}) : real(command, args));
    document.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (state === 'hidden') panel!.setVisible(false);
    if (state === 'destroyed') panel!.destroy();
    if (state === 'reset') panel!.reset();
    finish(f.page); await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('[data-artifact-preview]')).toBeNull();
});

it('clears old artifact scopes when the primary execution changes and waits for terminal output', async () => {
    const f = await artifactFixture();
    document.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-artifact-preview]')).not.toBeNull());
    f.call.status = 'running'; await panel!.refresh();
    expect(document.querySelector('[data-artifacts-load]')).toBeNull();
    expect(document.querySelector('[data-artifact-preview]')).toBeNull();
    f.call.status = 'completed'; f.call.receipt.execution!.taskId = 'replacement-task'; await panel!.refresh();
    expect(document.querySelector<HTMLElement>('[data-artifact-scope]')?.dataset.artifactScope).toBe(JSON.stringify(['child', 'replacement-task']));
});

it('rejects an artifact response from another execution without changing call admission', async () => {
    const f = await artifactFixture(); f.page.sessionId = 'foreign';
    document.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-artifacts] [role=alert]')?.textContent).toContain('ARTIFACT_RESPONSE_INVALID'));
    expect(document.querySelector('[data-artifact-preview]')).toBeNull();
    expect(f.operations.getSnapshot()).toEqual([]);
    expect(document.querySelector('[data-independent-call] [role=status]')?.textContent).toBe('已完成');
});


it('keeps observing cleanup after the Round completes instead of declaring all resources released', async () => {
    vi.useFakeTimers();
    const call = view(); call.receipt.execution = {taskId: 'primary', role: 'primary'};
    call.executionState = {id: 'primary', revision: 8, phase: 'done', control: {requested: 'pause', acknowledged: false},
        activeOperations: 1, settled: false, stopped: false, controlEpoch: 2};
    const execute = vi.fn(async () => [call]);
    panel = new IndependentCallPanel({execute} as unknown as ICommandBus, 'parent', document.body,
        {operations: createOperationLedger(), branch: () => 'main', openChild() {}});
    await panel.refresh();
    expect(document.querySelector('[data-execution-state]')!.textContent).toContain('1');
    expect(document.querySelector('[data-independent-call] header [role=status]')!.textContent).toBe('已完成');
    await vi.advanceTimersByTimeAsync(1000); expect(execute.mock.calls.filter(([command]) => command === IndependentCallCommand.List)).toHaveLength(2);
    call.executionState.settled = true; call.executionState.stopped = true; call.executionState.activeOperations = 0;
    await panel.refresh();
    expect(document.querySelector('[data-execution-state]')!.textContent).toBe('');
    const count = execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_000); expect(execute).toHaveBeenCalledTimes(count);
});

it('distinguishes requested pause from confirmed stopping and rejects another task state', async () => {
    const call = view(); call.receipt.execution = {taskId: 'primary', role: 'primary'}; call.status = 'waiting';
    call.executionState = {id: 'primary', revision: 1, phase: 'waiting', control: {requested: 'pause', acknowledged: false},
        activeOperations: 1, settled: false, stopped: false, controlEpoch: 1};
    panel = new IndependentCallPanel({execute: vi.fn(async () => [call])} as unknown as ICommandBus, 'parent', document.body,
        {operations: createOperationLedger(), branch: () => 'main', openChild() {}});
    await panel.refresh(); expect(document.querySelector('[data-execution-state]')!.textContent).toContain('尚未完成');
    call.executionState.control.acknowledged = true; call.executionState.stopped = true;
    await panel.refresh(); expect(document.querySelector('[data-execution-state]')!.textContent).toContain('已确认暂停');
    call.executionState.id = 'unrelated'; await panel.refresh();
    expect(document.querySelector('[role=alert]')!.textContent).toContain('CALL_VIEW_SCOPE_MISMATCH');
});

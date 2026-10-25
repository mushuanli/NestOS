import {createOperationLedger, type OperationLedger, type OperationRecord} from '@itookit/llm-ui';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {taskStat} from '@itookit/durable-kernel';
import type {TaskRecord} from '@itookit/durable-kernel/contracts';
import {FlowCommand, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import {FlowInvocationCommand, type ICommandBus} from '@itookit/llm-session/contracts';
import {t} from '@itookit/common';
import {InvocationPanel} from '../../llm-ui-adapter/src/flows/InvocationPanel';
import {invocationControl} from '../../llm-ui-adapter/src/flows/invocation-control';

let panel: InvocationPanel | undefined;
afterEach(() => {panel?.destroy(); panel = undefined; document.body.replaceChildren(); vi.restoreAllMocks();});

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
    return {id, rootTaskId: 'root', sessionId: 'session', status: 'waiting', program: {kind: 'fixture', version: '1'}, input: {initialScheduler: {controlTreeVersion: 1}},
        pendingEvents: [], unresolvedDeps: 0, priority: 0, retry: {maxAttempts: 1}, attemptCount: 1,
        effects: {}, interactions: {}, version: 1, createdAt: 1, updatedAt: 1, ...patch} as TaskRecord;
}
function paused(acknowledged: boolean, patch: Partial<TaskRecord> = {}): TaskRecord {
    return task('root', {control: {mode: 'pause', epoch: 7, requestId: 'pause-original', acknowledged}, ...patch});
}
function snapshot(root = task('root'), members: TaskRecord[] = []): DurableFlowSnapshot {
    return {controlStats: Object.fromEntries([root, ...members].map(task => [task.id, taskStat(task)])), root: {task: root}, taskTree: members, controlTaskIds: [root.id, ...members.map(task => task.id)],
        nodes: [], iterations: {}, detachedNodes: [], usage: {}} as DurableFlowSnapshot;
}
function leased(): TaskRecord['effects'] {return {native: {status: 'leased'}} as TaskRecord['effects'];}
function button(key: Parameters<typeof t>[0]): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('[data-actions] button')].find(button => button.textContent === t(key));
}
async function fixture(initial: DurableFlowSnapshot, operations?: OperationLedger) {
    let current = initial;
    const execute = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
        if (command === FlowInvocationCommand.List) return [{requestId: 'call', rootTaskId: 'root', flow: {name: 'Flow'}, revision: 1}];
        if (command === FlowCommand.RunGet) return structuredClone(current);
        return {};
    });
    panel = new InvocationPanel({execute} as unknown as ICommandBus, 'session', document.body, vi.fn(), {operations}); await panel.refresh();
    return {execute, state: () => current, set: (value: DurableFlowSnapshot) => {current = value;}, refresh: () => panel!.refresh()};
}

it('shows a pending pause while a native effect runs and keeps cancellation independent', async () => {
    const f = await fixture(snapshot(paused(false, {effects: leased()}))); expect(taskStat(f.state().root.task).stopped).toBe(false);
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.pausing'));
    expect(button('flow.invoke.continue')).toBeUndefined(); expect(button('flow.invoke.reattach')).toBeUndefined();
    expect(button('flow.invoke.withdrawPause')).toBeDefined(); expect(button('flow.invoke.cancel')!.disabled).toBe(false);
    button('flow.invoke.cancel')!.click();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunCancel, {taskId: 'root', sessionId: 'session'}));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RunGoalUpdate)).toBe(false);
});

it('waits for every controlled member even after root acknowledgement and rebuilds actions when the child stops', async () => {
    const child = task('worker', {controlHolds: ['root'], effects: leased()}), f = await fixture(snapshot(paused(true), [child]));
    expect(taskStat(f.state().root.task).stopped).toBe(true); expect(taskStat(child).stopped).toBe(false);
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.pausing')); expect(button('flow.invoke.continue')).toBeUndefined();
    const root = f.state().root.task; child.effects = {}; child.version++; f.set(snapshot(root, [child])); await f.refresh();
    expect(taskStat(child).stopped).toBe(true); expect(taskStat(child).settled).toBe(false);
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.paused')); expect(button('flow.invoke.continue')).toBeDefined();
});

it('updates pause actions on acknowledgement without a display-status change and preserves them during token revisions', async () => {
    const f = await fixture(snapshot(paused(false))); expect(button('flow.invoke.withdrawPause')).toBeDefined();
    f.set(snapshot(paused(true))); await f.refresh(); const resume = button('flow.invoke.continue'); expect(resume).toBeDefined();
    f.set(snapshot(paused(true, {version: 2, output: {partial: 'private output'}}))); await f.refresh();
    expect(button('flow.invoke.continue')).toBe(resume);
});

it.each(['succeeded', 'failed', 'cancelled'] as const)('gives terminal %s priority over stale pause and external hold fields', async status => {
    await fixture(snapshot(paused(true, {status, sessionPaused: true, controlHolds: ['ancestor']})));
    expect(document.querySelector('[data-status]')!.textContent).toBe(t(`flow.invoke.${status}`));
    expect(button('flow.invoke.repeat')).toBeDefined(); expect(button('flow.invoke.cancel')).toBeUndefined();
    expect(button('flow.invoke.continue')).toBeUndefined(); expect(button('flow.invoke.withdrawPause')).toBeUndefined();
});

it.each([{sessionPaused: true}, {controlHolds: ['ancestor']}])('does not invent a call resume action for an external hold %j', async hold => {
    const root = task('root', hold); await fixture(snapshot(root)); expect(taskStat(root).stopped).toBe(true);
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.constrained'));
    expect(button('flow.invoke.continue')).toBeUndefined(); expect(button('flow.invoke.releasePause')).toBeUndefined();
    expect(button('flow.invoke.cancel')).toBeDefined();
});

it('releases only a confirmed own pause and continues to show the session constraint', async () => {
    const f = await fixture(snapshot(paused(true, {sessionPaused: true})));
    expect(document.querySelector('[data-status]')!.textContent).toContain(t('flow.invoke.constrained'));
    button('flow.invoke.releasePause')!.click();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunGoalUpdate, {taskId: 'root', requestId: expect.any(String), expectedEpoch: 7, goal: {status: 'active'}}));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RunResume)).toBe(false);
    f.set(snapshot(task('root', {version: 2, sessionPaused: true}))); await f.refresh();
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.constrained')); expect(button('flow.invoke.continue')).toBeUndefined();
});

it('uses current control membership rather than unrelated historical tasks and remains conservative when a member is missing', async () => {
    const current = snapshot(paused(true)); current.taskTree.push(task('history', {status: 'running', effects: leased()}));
    const f = await fixture(current); expect(button('flow.invoke.continue')).toBeDefined();
    current.controlTaskIds!.push('missing'); f.set(current); await f.refresh();
    expect(button('flow.invoke.continue')).toBeUndefined(); expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.pausing'));
});

it('includes detached members that retain run ownership and suppresses withdrawal during cleanup', async () => {
    const child = task('detached', {controlHolds: ['root'], effects: leased()}), current = snapshot(paused(true), [child]);
    current.detachedNodes = ['node']; const f = await fixture(current); expect(button('flow.invoke.continue')).toBeUndefined();
    f.set(snapshot(paused(false, {effects: {cleanup: {status: 'completed', cleanupPending: true}} as TaskRecord['effects']}))); await f.refresh();
    expect(button('flow.invoke.withdrawPause')).toBeUndefined(); expect(button('flow.invoke.cancel')).toBeDefined();
});

it('withdraws a pending pause with one stable request identity and the observed epoch, without calling resume', async () => {
    const f = await fixture(snapshot(paused(false, {effects: leased()}))), base = f.execute.getMockImplementation()!;
    let attempts = 0;
    f.execute.mockImplementation(async (command, input) => {
        if (command !== FlowCommand.RunPauseWithdraw) return base(command, input);
        if (++attempts === 1) throw Object.assign(new Error('Receipt unavailable'), {code: 'ECONNECTION'});
        f.set(snapshot(task('root', {version: 2, effects: leased()}))); return {};
    });
    button('flow.invoke.withdrawPause')!.click(); await vi.waitFor(() => expect(attempts).toBe(1));
    await vi.waitFor(() => expect(button('flow.invoke.withdrawPause')!.disabled).toBe(false)); button('flow.invoke.withdrawPause')!.click();
    await vi.waitFor(() => expect(attempts).toBe(2));
    const calls = f.execute.mock.calls.filter(([command]) => command === FlowCommand.RunPauseWithdraw);
    expect(calls[0][1]).toMatchObject({taskId: 'root', requestId: expect.any(String), expectedEpoch: 7}); expect(calls[1][1]).toEqual(calls[0][1]);
    expect(f.execute.mock.calls.some(([command]) => [FlowCommand.RunResume, FlowCommand.RunGoalUpdate].includes(command as never))).toBe(false);
    expect(f.state().root.task.effects).toEqual(leased());
});

it('refreshes an acknowledged withdrawal race without automatically resuming the call', async () => {
    const f = await fixture(snapshot(paused(false))); f.set(snapshot(paused(true, {version: 2})));
    button('flow.invoke.withdrawPause')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-error]')!.textContent).toContain(t('flow.invoke.pauseChanged')));
    await vi.waitFor(() => expect(button('flow.invoke.continue')).toBeDefined());
    expect(f.execute.mock.calls.some(([command]) => command === FlowCommand.RunPauseWithdraw || command === FlowCommand.RunGoalUpdate)).toBe(false);
});

it('rejects a stale resume click when the fresh tree has active work and leaves cancellation available', async () => {
    const f = await fixture(snapshot(paused(true))), child = task('worker', {controlHolds: ['root'], effects: leased()});
    f.set(snapshot(paused(true, {version: 2}), [child])); button('flow.invoke.continue')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-error]')!.textContent).toContain(t('flow.invoke.pauseUnconfirmed')));
    expect(f.execute.mock.calls.some(([command]) => command === FlowCommand.RunGoalUpdate)).toBe(false);
    expect(button('flow.invoke.cancel')!.disabled).toBe(false);
});

it('ignores an older root or member snapshot after pause acknowledgement', async () => {
    const root = paused(true, {version: 4}), child = task('worker', {version: 4, controlHolds: ['root']});
    const f = await fixture(snapshot(root, [child])), resume = button('flow.invoke.continue');
    f.set(snapshot(paused(false, {version: 3}), [child])); await f.refresh(); expect(button('flow.invoke.continue')).toBe(resume);
    f.set(snapshot(root, [task('worker', {version: 3, controlHolds: ['root'], effects: leased()})])); await f.refresh();
    expect(button('flow.invoke.continue')).toBe(resume);
});

it.each(['hidden', 'destroyed'])('does not send a late withdrawal after the panel is %s', async action => {
    const f = await fixture(snapshot(paused(false))), base = f.execute.getMockImplementation()!;
    let release!: (value: unknown) => void;
    f.execute.mockImplementation((command, input) => command === FlowCommand.RunGet ? new Promise(resolve => {release = resolve;}) : base(command, input));
    button('flow.invoke.withdrawPause')!.click(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (action === 'hidden') panel!.setVisible(false); else panel!.destroy();
    release(f.state()); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.execute.mock.calls.some(([command]) => command === FlowCommand.RunPauseWithdraw)).toBe(false);
});

it('keeps host scheduler reattachment separate from pause release and never offers it during a pending pause', async () => {
    const current = snapshot(task('root')); current.attachedFromStorage = true; const f = await fixture(current);
    expect(button('flow.invoke.reattach')).toBeDefined(); expect(button('flow.invoke.continue')).toBeUndefined();
    button('flow.invoke.reattach')!.click();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunResume, {taskId: 'root', sessionId: 'session'}));
    f.set({...snapshot(paused(false, {version: 2})), attachedFromStorage: true}); await f.refresh();
    expect(button('flow.invoke.reattach')).toBeUndefined(); expect(button('flow.invoke.continue')).toBeUndefined();
});

it.each(['release', 'withdraw'])('reattaches a stored paused scheduler before %s and verifies control again', async action => {
    const current = {...snapshot(paused(action === 'release')), attachedFromStorage: true}, f = await fixture(current);
    button(action === 'release' ? 'flow.invoke.continue' : 'flow.invoke.withdrawPause')!.click();
    const command = action === 'release' ? FlowCommand.RunGoalUpdate : FlowCommand.RunPauseWithdraw;
    await vi.waitFor(() => expect(f.execute.mock.calls.some(([name]) => name === command)).toBe(true));
    const names = f.execute.mock.calls.map(([name]) => name), reattach = names.indexOf(FlowCommand.RunResume), control = names.indexOf(command);
    expect(reattach).toBeGreaterThan(-1); expect(control).toBeGreaterThan(reattach);
    expect(names.slice(reattach + 1, control)).toContain(FlowCommand.RunGet);
});

it('uses the displayed control epoch and never applies an old pause click to a newer control', async () => {
    const f = await fixture(snapshot(task('root', {control: {mode: 'run', epoch: 1, requestId: 'old', acknowledged: true}})));
    f.set(snapshot(task('root', {version: 2, control: {mode: 'run', epoch: 2, requestId: 'new', acknowledged: true}})));
    button('flow.invoke.pause')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-error]')!.textContent).toContain(t('flow.invoke.pauseChanged')));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RunGoalUpdate)).toBe(false);
});

it.each(['pause', 'resume'])('retries %s with one control request identity and the displayed epoch', async action => {
    const initial = action === 'pause' ? task('root', {control: {mode: 'run', epoch: 7, requestId: 'previous', acknowledged: true}}) : paused(true);
    const f = await fixture(snapshot(initial)), base = f.execute.getMockImplementation()!; let attempts = 0;
    f.execute.mockImplementation(async (command, input) => {
        if (command !== FlowCommand.RunGoalUpdate) return base(command, input);
        if (++attempts === 1) throw Object.assign(new Error('Reply unavailable'), {code: 'ECONNECTION'}); return {};
    });
    const key = action === 'pause' ? 'flow.invoke.pause' : 'flow.invoke.continue'; button(key)!.click();
    await vi.waitFor(() => expect(attempts).toBe(1)); await vi.waitFor(() => expect(button(key)!.disabled).toBe(false)); button(key)!.click();
    await vi.waitFor(() => expect(attempts).toBe(2)); const calls = f.execute.mock.calls.filter(([name]) => name === FlowCommand.RunGoalUpdate);
    expect(calls[0][1]).toMatchObject({requestId: expect.any(String), expectedEpoch: 7}); expect(calls[1][1]).toEqual(calls[0][1]);
});

it('agrees with Kernel stopped semantics for pending, leased, indeterminate, reducer and cleanup boundaries', () => {
    const records = [paused(true), paused(false), paused(true, {effects: leased()}),
        paused(true, {effects: {effect: {status: 'pending'}} as TaskRecord['effects']}),
        paused(true, {effects: {effect: {status: 'indeterminate'}} as TaskRecord['effects']}),
        paused(true, {currentAttempt: {attemptId: 'attempt'} as TaskRecord['currentAttempt']}),
        paused(true, {effects: {effect: {status: 'completed', cleanupPending: true}} as TaskRecord['effects']})];
    for (const root of records) expect(invocationControl(snapshot(root)).canRelease).toBe(root.control!.acknowledged && taskStat(root).stopped);
});

it.each([undefined, null, [], {}, {initialScheduler: []}, {initialScheduler: {}}, {initialScheduler: {controlTreeVersion: 2}}, {initialScheduler: {controlTreeVersion: '1'}}])('disables new pause and withdrawal when frozen tree capability is absent or invalid: %j', async input => {
    const f = await fixture(snapshot(task('root', {input})));
    expect(button('flow.invoke.pause')).toBeUndefined(); expect(button('flow.invoke.cancel')).toBeDefined();
    expect(document.querySelector('[data-control-notice]')!.textContent).toBe(t('flow.invoke.legacyPause'));
    f.set(snapshot(paused(false, {input, version: 2}))); await f.refresh(); expect(button('flow.invoke.withdrawPause')).toBeUndefined();
});

it('offers limited legacy recovery only after an old own pause and its members are stopped', async () => {
    const f = await fixture(snapshot(paused(true, {input: {}}))); expect(button('flow.invoke.continue')).toBeUndefined();
    expect(button('flow.invoke.legacyResume')).toBeDefined(); button('flow.invoke.legacyResume')!.click();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunGoalUpdate, {taskId: 'root', requestId: expect.any(String), expectedEpoch: 7, goal: {status: 'active'}}));
    f.set(snapshot(paused(true, {input: {}, version: 2, effects: leased()}))); await f.refresh();
    expect(button('flow.invoke.legacyResume')).toBeUndefined(); expect(button('flow.invoke.cancel')).toBeDefined();
});

it('shows retained legacy child pauses after limited recovery without exposing their identities', async () => {
    const f = await fixture(snapshot(paused(true, {input: {}}))), base = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, input) => command === FlowCommand.RunGoalUpdate
        ? {limitedRecovery: true, retainedTaskIds: ['private-child']} : base(command, input));
    button('flow.invoke.legacyResume')!.click();
    await vi.waitFor(async () => {await f.refresh(); expect(document.querySelector('[data-control-notice]')!.textContent).toContain(t('flow.invoke.legacyRetained', {count: 1}));});
    expect(document.querySelector('[data-control-notice]')!.textContent).not.toContain('private-child');
});

it('follows the committed root control when a withdrawal reply or goal write is lost', async () => {
    const current = snapshot(paused(false)), f = await fixture(current), base = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, input) => {
        if (command !== FlowCommand.RunPauseWithdraw) return base(command, input);
        f.set({...snapshot(task('root', {version: 2, control: {mode: 'run', epoch: 8, requestId: 'withdrawn', acknowledged: true}})), goal: {status: 'paused'}} as DurableFlowSnapshot);
        throw Object.assign(new Error('Goal write unavailable'), {code: 'ECONNECTION'});
    });
    button('flow.invoke.withdrawPause')!.click();
    await vi.waitFor(async () => {await f.refresh(); expect(button('flow.invoke.pause')).toBeDefined();});
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.waiting'));
    expect(button('flow.invoke.withdrawPause')).toBeUndefined(); expect(button('flow.invoke.continue')).toBeUndefined();
});

it('does not let delayed goal metadata hide control actions or an older control epoch overwrite them', async () => {
    const root = task('root', {control: {mode: 'run', epoch: 8, requestId: 'new', acknowledged: true}}), f = await fixture(snapshot(root));
    const pause = button('flow.invoke.pause');
    f.set({...snapshot(root), goal: {status: 'paused'}} as DurableFlowSnapshot); await f.refresh(); expect(button('flow.invoke.pause')).toBe(pause);
    f.set(snapshot(paused(false, {version: root.version}))); await f.refresh();
    expect(button('flow.invoke.pause')).toBe(pause); expect(button('flow.invoke.withdrawPause')).toBeUndefined();
});

it('does not display pending interactions belonging only to historical attempts', async () => {
    const old = task('old', {interactions: {question: {id: 'question', kind: 'input', status: 'pending', prompt: 'Historical question'}} as TaskRecord['interactions']});
    const current = snapshot(task('root'), [old]); current.controlTaskIds = ['root'];
    await fixture(current);
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.waiting'));
    expect(document.querySelector('[data-interactions]')!.children).toHaveLength(0);
});

it('keeps cancellation available while a pause request is still awaiting its reply', async () => {
    const f = await fixture(snapshot()), base = f.execute.getMockImplementation()!;
    let release!: (value: unknown) => void;
    f.execute.mockImplementation((command, input) => command === FlowCommand.RunGoalUpdate
        ? new Promise(resolve => {release = resolve;}) : base(command, input));
    button('flow.invoke.pause')!.click(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    button('flow.invoke.cancel')!.click();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunCancel, {taskId: 'root', sessionId: 'session'}));
    release({});
});

it('does not send a delayed cancel after the panel is hidden during target lookup', async () => {
    const f = await fixture(snapshot()), base = f.execute.getMockImplementation()!;
    let release!: (value: unknown) => void;
    f.execute.mockImplementation((command, input) => command === FlowCommand.RunGet
        ? new Promise(resolve => {release = resolve;}) : base(command, input));
    button('flow.invoke.cancel')!.click(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    panel!.setVisible(false); release(f.state()); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RunCancel)).toBe(false);
});


it('does not infer confirmed stoppage when the host omits Kernel control statistics', async () => {
    const current = snapshot(paused(true)); delete current.controlStats;
    await fixture(current);
    expect(button('flow.invoke.continue')).toBeUndefined();
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.pausing'));
    expect(button('flow.invoke.cancel')).toBeDefined();
});


it('restores a pending control after reopening and queries its original receipt without dispatch', async () => {
    let saved: readonly OperationRecord[] = [];
    const ledger = () => createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}});
    const first = await fixture(snapshot(), ledger()), base = first.execute.getMockImplementation()!;
    first.execute.mockImplementation(async (command, args) => {
        if (command === FlowCommand.RunGoalUpdate) throw new Error('Reply lost');
        return base(command, args);
    });
    button('flow.invoke.pause')!.click(); await vi.waitFor(() => expect(saved[0]?.status).toBe('unknown'));
    const id = saved[0].context.operationId; panel!.destroy();
    const second = await fixture(snapshot(), ledger()), read = second.execute.getMockImplementation()!;
    second.execute.mockImplementation(async (command, args) => command === FlowCommand.RunControlReceipt
        ? {requestId: id, action: 'pause', expectedEpoch: 0, accepted: {requestId: id}} : read(command, args));
    document.querySelector<HTMLButtonElement>('[data-control-reconcile]')!.click();
    await vi.waitFor(() => expect(saved[0].status).toBe('accepted'));
    expect(second.execute.mock.calls.some(([name]) => name === FlowCommand.RunGoalUpdate)).toBe(false);
});

it('does not dispatch a control after its view closes while registration is still being saved', async () => {
    let release!: () => void;
    const operations = createOperationLedger({save: () => new Promise<void>(resolve => {release = resolve;})});
    const f = await fixture(snapshot(), operations);
    button('flow.invoke.pause')!.click(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    panel!.setVisible(false); release();
    await vi.waitFor(() => expect(operations.getSnapshot()).toHaveLength(1));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RunGoalUpdate)).toBe(false);
    // Release the subsequent local unknown receipt write without restarting the view.
    await new Promise(resolve => setTimeout(resolve, 0)); release();
});

it('refuses a child card snapshot from another execution Session without exposing executable interactions', async () => {
    const execute = vi.fn(async (command: string) => command === FlowInvocationCommand.List
        ? [{requestId: 'call', rootTaskId: 'root', executionSessionId: 'child', flow: {name: 'Flow'}, revision: 1}]
        : snapshot(task('root', {sessionId: 'wrong', interactions: {answer: {id: 'answer', status: 'pending', prompt: 'Wrong scope'}} as any})));
    panel = new InvocationPanel({execute} as never, 'session', document.body, vi.fn()); await panel.refresh();
    expect(document.querySelector('[data-error]')?.textContent).toContain('does not belong to the saved child Session');
    expect(document.querySelector('[data-interaction-action="reply"]')).toBeNull();
    expect(button('flow.invoke.pause')).toBeUndefined();
    expect(document.querySelector('[data-child-session] button')).toBeNull();
    expect(execute.mock.calls.every(([name]) => [FlowInvocationCommand.List, FlowCommand.RunGet].includes(name as never))).toBe(true);
});

it('opens a prepared child Session even when its root has not yet been attached, without invoking it again', async () => {
    const openChild = vi.fn(), execute = vi.fn(async (_command: string) =>
        [{requestId: 'call', executionSessionId: 'child', flow: {name: 'Flow'}, revision: 1}]);
    panel = new InvocationPanel({execute} as never, 'session', document.body, vi.fn(), {openChild}); await panel.refresh();
    document.querySelector<HTMLButtonElement>('[data-child-session] button')!.click();
    await vi.waitFor(() => expect(openChild).toHaveBeenCalledExactlyOnceWith('child'));
    expect(execute.mock.calls.every(([name]) => name === FlowInvocationCommand.List)).toBe(true);
    expect(button('flow.invoke.cancel')).toBeUndefined();
});

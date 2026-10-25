// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallView, type IndependentCallCancelRequest} from '@itookit/llm-session/contracts';
import {IndependentCallPanel} from '../../llm-ui-adapter/src/components/IndependentCallPanel';

let panel: IndependentCallPanel | undefined;
afterEach(() => {panel?.destroy(); panel = undefined; vi.useRealTimers(); document.body.replaceChildren();});
function call(): IndependentCallView {
    return {input: {title: 'Work', request: {expectedSessionId: 'parent', expectedBranch: 'main',
        source: {kind: 'arguments', value: {}}, submission: {id: 'call', source: {kind: 'conversation', ownerId: 'parent', id: 'call'}}}},
        createdAt: 1, head: null, status: 'running', receipt: {operationId: 'call', callerSessionId: 'parent', status: 'accepted', executionSessionId: 'child', execution: {taskId: 'task', role: 'primary'}},
        controlCapabilities: {cancel: true}, executionState: {id: 'task', revision: 1, phase: 'running', control: {requested: 'run', acknowledged: true},
            blockedBy: undefined, activeOperations: 1, stopped: false, settled: false, controlEpoch: 0}};
}
const button = () => document.querySelector<HTMLButtonElement>('[data-call-cancel]')!;
function receipt(request: IndependentCallCancelRequest) {
    const {expectedEpoch, ...query} = request;
    return {...query, receipt: {requestId: request.requestId, taskId: request.taskId, expectedEpoch, controlEpoch: expectedEpoch, status: 'cancelled'}};
}
it('queries a hanging cancellation independently and restores it without dispatching twice', async () => {
    let saved: readonly OperationRecord[] = [], request!: IndependentCallCancelRequest;
    const execute = vi.fn(async (name: string, args?: unknown) => {
        if (name === IndependentCallCommand.List) return [call()];
        if (name === IndependentCallCommand.Cancel) {request = args as IndependentCallCancelRequest; return new Promise(() => {});}
        if (name === IndependentCallCommand.CancellationReceipt) return receipt(request);
        throw new Error(name);
    });
    const open = () => {
        const operations = createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}});
        panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'}); return operations;
    };
    open(); await panel!.refresh(); button().click();
    await vi.waitFor(() => expect(request?.requestId).toBeTruthy());
    await vi.waitFor(() => expect(saved[0]?.status).toBe('accepted'));
    expect(button().hidden).toBe(true); expect(document.body.textContent).not.toContain('已停止');
    panel!.destroy(); document.body.replaceChildren(); open(); await panel!.refresh();
    expect(button().hidden).toBe(true);
    expect(execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Cancel)).toHaveLength(1);
});
it('keeps missing receipt observation bounded and permits a fresh query after hiding a hung read', async () => {
    const view = call(), request: IndependentCallCancelRequest = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'task', requestId: 'cancel', expectedEpoch: 0};
    const operations = createOperationLedger({initial: [{context: {viewId: 'control', operationId: 'cancel'}, conversationId: 'parent', kind: 'command', status: 'unknown', input: {protocol: 'independent-call-cancel-v1', request}}]});
    let reads = 0;
    const execute = vi.fn(async (name: string) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.CancellationReceipt) {reads++; return reads === 1 ? new Promise(() => {}) : receipt(request);}
        throw new Error('No mutation allowed');
    });
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'});
    await panel.refresh(); expect(reads).toBe(1); panel.setVisible(false); panel.setVisible(true); await panel.refresh();
    await vi.waitFor(() => expect(operations.getSnapshot()[0].status).toBe('accepted'));
    expect(reads).toBe(2); expect(execute.mock.calls.some(([name]) => name === IndependentCallCommand.Cancel)).toBe(false);
});
it('does not dispatch after the view closes while its operation is being saved', async () => {
    let finish!: () => void;
    const operations = createOperationLedger({save: () => new Promise<void>(resolve => {finish = resolve;})});
    const execute = vi.fn(async (name: string) => {if (name === IndependentCallCommand.List) return [call()]; throw new Error('Unexpected mutation');});
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'}); await panel.refresh();
    button().click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); panel.setVisible(false); finish();
    await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('submitting')); finish();
    await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('rejected'));
    expect(execute.mock.calls.some(([name]) => name === IndependentCallCommand.Cancel)).toBe(false);
});
it('hides cancellation without declared host support or when the task is terminal', async () => {
    const view = call(); delete view.controlCapabilities;
    const execute = vi.fn(async () => [view]);
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations: createOperationLedger(), branch: () => 'main'});
    await panel.refresh(); expect(button().hidden).toBe(true); expect(stateButton().hidden).toBe(true);
    view.controlCapabilities = {cancel: true}; view.executionState!.phase = 'done'; await panel.refresh(); expect(button().hidden).toBe(true); expect(stateButton().hidden).toBe(true);
});

const stateButton = () => document.querySelector<HTMLButtonElement>('[data-call-state-control]')!;
it('keeps cancellation independent of unknown pause and permits resume after receipt even while dispatch hangs', async () => {
    const view = call(); view.controlCapabilities = {cancel: true, pause: 'boundary', resume: true, withdrawPause: true};
    const operations = createOperationLedger(); let request: any, available = false;
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.Control) {request = args; return new Promise(() => {});}
        if (name === IndependentCallCommand.ControlReceipt) {
            if (!available) return args;
            return {...args, receipt: {requestId: args.requestId, expectedEpoch: request.expectedEpoch, action: request.action === 'resume' ? 'run' : request.action,
                accepted: {requestId: args.requestId, mode: 'pause', epoch: 1}}};
        }
        if (name === IndependentCallCommand.Cancel) return receipt(args);
        throw new Error(name);
    });
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'});
    await panel.refresh(); stateButton().click();
    await vi.waitFor(() => expect(request?.action).toBe('pause'));
    await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('unknown'));
    expect(button().disabled).toBe(false); expect(button().hidden).toBe(false);
    available = true; await panel.refresh();
    await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('accepted'));
    await panel.refresh(); expect(stateButton().disabled).toBe(true);
    view.executionState!.controlEpoch = 1; view.executionState!.control = {requested: 'pause', acknowledged: true};
    await panel.refresh(); expect(stateButton().disabled).toBe(false); stateButton().click();
    await vi.waitFor(() => expect(request.action).toBe('resume'));
    expect(request.expectedEpoch).toBe(1); expect(operations.getSnapshot().every(record => !record.draft)).toBe(true);
    button().click(); await vi.waitFor(() => expect(execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Cancel)).toHaveLength(1));
});
it('offers withdrawal only before acknowledgement and preserves controls through hidden view recovery', async () => {
    const view = call(); view.controlCapabilities = {cancel: true, pause: 'boundary', resume: true, withdrawPause: true};
    view.executionState!.control = {requested: 'pause', acknowledged: false}; view.executionState!.controlEpoch = 2;
    const operations = createOperationLedger(); let request: any;
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.Control) {request = args; return new Promise(() => {});}
        if (name === IndependentCallCommand.ControlReceipt) return args;
        throw new Error(name);
    });
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'});
    await panel.refresh(); stateButton().click(); await vi.waitFor(() => expect(request?.action).toBe('withdraw'));
    panel.setVisible(false); expect(stateButton().disabled).toBe(true); panel.setVisible(true); await panel.refresh();
    expect(execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Control)).toHaveLength(1);
    expect(operations.getSnapshot()[0].input).toMatchObject({request: {action: 'withdraw', expectedEpoch: 2}});
});
it('shows pending interactions outside collapsed details and opens the existing child without submitting an answer', async () => {
    const view = call(); view.interactions = {total: 2, items: [{taskId: 'worker', interactionId: 'ask', kind: 'approval',
        prompt: '<script>not executable</script>', promptTruncated: true, requestedAt: 1}]};
    const execute = vi.fn(async (name: string) => {if (name === IndependentCallCommand.List) return [view]; throw new Error('No mutation');});
    const openChild = vi.fn(); panel = new IndependentCallPanel({execute} as never, 'parent', document.body,
        {operations: createOperationLedger(), branch: () => 'main', openChild});
    await panel.refresh(); const pending = document.querySelector<HTMLElement>('[data-call-interactions]')!;
    expect(pending.hidden).toBe(false); expect(pending.closest('details')).toBeNull(); expect(pending.querySelector('script')).toBeNull();
    expect(pending.textContent).toContain('<script>not executable</script>');
    pending.querySelector<HTMLButtonElement>('[data-open-interactions]')!.click(); await vi.waitFor(() => expect(openChild).toHaveBeenCalledWith('child'));
    expect(execute.mock.calls.every(([name]) => name === IndependentCallCommand.List)).toBe(true);
    view.interactions = {total: 0, items: []}; await panel.refresh(); expect(pending.hidden).toBe(true);
});
it('preserves an answer editor during refresh and reconciles it after the pending interaction disappears', async () => {
    const view = call(); view.controlCapabilities!.respond = true;
    view.interactions = {total: 1, items: [{taskId: 'worker', interactionId: 'ask', kind: 'input', prompt: 'Short', promptTruncated: true, requestedAt: 1}]};
    let saved: readonly OperationRecord[] = [], answer: any, detailReads = 0;
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.Interaction) {detailReads++; return {...args, interaction: {id: 'ask', kind: 'input', prompt: '<full prompt>', payload: {instructions: 'Full material'}, requestedAt: 1, status: 'pending'}};}
        if (name === IndependentCallCommand.Respond) {answer = args; view.interactions = {total: 0, items: []}; return new Promise(() => {});}
        if (name === IndependentCallCommand.ResponseReceipt) return {...args, receipt: {requestId: args.requestId, taskId: args.targetTaskId, interactionId: args.interactionId, resolvedAt: 2}};
        throw new Error(name);
    });
    const operations = createOperationLedger({save: async records => {saved = structuredClone(records);}});
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'}); await panel.refresh();
    document.querySelector<HTMLButtonElement>('[data-call-answer-action]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-call-answer] textarea')).not.toBeNull());
    const editor = document.querySelector<HTMLTextAreaElement>('[data-call-answer] textarea')!; editor.value = '{"literal":"text"}';
    await panel.refresh(); expect(document.querySelector('[data-call-answer] textarea')).toBe(editor); expect(editor.value).toContain('literal'); expect(detailReads).toBe(1);
    editor.closest('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(answer?.value).toBe('{"literal":"text"}'));
    await panel.refresh(); await vi.waitFor(() => expect(saved[0]?.status).toBe('accepted'));
    expect(saved[0].draft).toBeUndefined(); expect(saved[0].input).toMatchObject({protocol: 'independent-call-response-v1', request: {value: '{"literal":"text"}'}});
    expect(execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Respond)).toHaveLength(1);
});
it('requires full details before approving and keeps JSON parse errors editable without dispatch', async () => {
    const view = call(); view.controlCapabilities!.respond = true;
    view.interactions = {total: 1, items: [{taskId: 'worker', interactionId: 'ask', kind: 'input', prompt: 'Input', promptTruncated: false, requestedAt: 1}]};
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.Interaction) return {...args, interaction: {id: 'ask', kind: 'input', prompt: 'Input', requestedAt: 1, status: 'pending'}};
        throw new Error('No answer expected');
    });
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations: createOperationLedger(), branch: () => 'main'}); await panel.refresh();
    expect(document.querySelector('[data-call-answer] form')).toBeNull(); document.querySelector<HTMLButtonElement>('[data-call-answer-action]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-call-answer] textarea')).not.toBeNull());
    const row = document.querySelector<HTMLElement>('[data-call-answer]')!; row.querySelector('select')!.value = 'json'; row.querySelector('textarea')!.value = '{invalid';
    row.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(row.textContent).toContain('JSON')); expect(row.querySelector('textarea')!.disabled).toBe(false);
    expect(execute.mock.calls.some(([name]) => name === IndependentCallCommand.Respond)).toBe(false);
});
it('shows complete approval material and persists the explicit rejection without affecting cancellation', async () => {
    const view = call(); view.controlCapabilities!.respond = true;
    view.interactions = {total: 1, items: [{taskId: 'worker', interactionId: 'approve', kind: 'approval', prompt: 'Preview', promptTruncated: true, requestedAt: 1}]};
    const operations = createOperationLedger(); let sent: any;
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.Interaction) return {...args, interaction: {id: 'approve', kind: 'approval', prompt: 'Approve full change', payload: {command: '<untrusted command>'}, requestedAt: 1, status: 'pending'}};
        if (name === IndependentCallCommand.Respond) {sent = args; return {...args, receipt: {requestId: args.requestId, taskId: 'worker', interactionId: 'approve', resolvedAt: 2}};}
        throw new Error(name);
    });
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'}); await panel.refresh();
    document.querySelector<HTMLButtonElement>('[data-call-answer-action]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-call-answer] form')).not.toBeNull());
    const row = document.querySelector('[data-call-answer]')!; expect(row.textContent).toContain('<untrusted command>');
    expect(row.querySelector('untrusted')).toBeNull(); row.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Do not proceed';
    row.querySelectorAll<HTMLButtonElement>('form button')[1].click();
    await vi.waitFor(() => expect(sent?.value).toEqual({approved: false, note: 'Do not proceed'}));
    expect(button().disabled).toBe(false); expect(operations.getSnapshot()[0].draft).toBeUndefined();
});
it('restores an unknown answer after its interaction leaves the pending list without creating another editor or response', async () => {
    const view = call(); view.interactions = {total: 0, items: []}; view.controlCapabilities!.respond = true;
    const request = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'task', targetTaskId: 'worker', interactionId: 'ask', requestId: 'answer-saved', value: 'Saved answer'};
    const operations = createOperationLedger({initial: [{context: {operationId: 'answer-saved', viewId: 'test'}, conversationId: 'parent', kind: 'command', status: 'unknown', input: {protocol: 'independent-call-response-v1', request}}]});
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.ResponseReceipt) return args;
        throw new Error('No new mutation or detail read');
    });
    panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {operations, branch: () => 'main'}); await panel.refresh();
    await vi.waitFor(() => expect(execute.mock.calls.some(([name]) => name === IndependentCallCommand.ResponseReceipt)).toBe(true));
    expect(document.querySelector('[data-saved-answer]')!.textContent).toContain('Saved answer');
    expect(document.querySelector('[data-call-answer] form')).toBeNull();
    panel.setVisible(false); panel.setVisible(true); await panel.refresh();
    expect(execute.mock.calls.some(([name]) => name === IndependentCallCommand.Respond)).toBe(false);
});

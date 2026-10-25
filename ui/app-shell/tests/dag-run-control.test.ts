// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {Toast} from '@itookit/ui-common';
import {DagWorkbench} from '../../llm-ui-adapter/src/components/DagWorkbench';
import {FlowsEditor} from '../../llm-ui-adapter/src/components/FlowsEditor';

const views: DagWorkbench[] = [];
afterEach(() => {views.splice(0).forEach(view => view.destroy()); vi.restoreAllMocks();});
function snapshot(control?: object, stopped = false) {
    const task = {id: 'root', sessionId: 's', status: 'waiting', input: {initialScheduler: {controlTreeVersion: 1}}, control, effects: {}, interactions: {}};
    return {root: {task}, taskTree: [], controlTaskIds: ['root'], controlStats: {root: {stopped}}, nodes: [],
        iterations: {}, detachedNodes: [], usage: {tokens: 0, elapsedMs: 0}};
}
async function fixture(state = snapshot()) {
    let saved: readonly OperationRecord[] = [];
    const ledger = () => createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}});
    const execute = vi.fn(async (name: string, _args?: any): Promise<any> => name === FlowCommand.RunGet ? state : {});
    const open = async () => {
        const root = document.createElement('div');
        const view = new DagWorkbench(root, {commands: {execute} as never, operations: async () => ledger()}); views.push(view);
        await view.openRun('root', 's'); return {root, view};
    };
    return {execute, open, saved: () => saved};
}
function click(root: HTMLElement, action: string) {root.querySelector<HTMLButtonElement>(`[data-run-control="${action}"]`)!.click();}

it('persists pause before dispatch and only queries the original receipt after reopening', async () => {
    vi.spyOn(Toast, 'error').mockImplementation(() => {});
    const f = await fixture();
    f.execute.mockImplementation(async (name, args) => {
        if (name === FlowCommand.RunGet) return snapshot();
        if (name === FlowCommand.RunGoalUpdate) {
            expect(f.saved()[0]).toMatchObject({status: 'submitting', context: {operationId: args.requestId}});
            throw new Error('Lost response');
        }
        if (name === FlowCommand.RunControlReceipt) return {requestId: args.requestId, action: 'pause', expectedEpoch: 0, accepted: {requestId: args.requestId}};
        return {};
    });
    const first = await f.open(); click(first.root, 'pause');
    await vi.waitFor(() => expect(f.saved()[0]?.status).toBe('unknown'));
    first.view.destroy(); const next = await f.open();
    const id = f.saved()[0].context.operationId; click(next.root, `receipt:${id}`);
    await vi.waitFor(() => expect(f.saved()[0].status).toBe('accepted'));
    expect(f.execute.mock.calls.filter(([name]) => name === FlowCommand.RunGoalUpdate)).toHaveLength(1);
});

it.each(['resume', 'withdraw'] as const)('uses explicit %s with the observed control epoch', async action => {
    const f = await fixture(snapshot({mode: 'pause', epoch: 7, acknowledged: action === 'resume'}, action === 'resume'));
    const {root} = await f.open(); click(root, action);
    await vi.waitFor(() => expect(f.saved()[0]?.status).toBe('accepted'));
    expect(f.execute).toHaveBeenCalledWith(action === 'resume' ? FlowCommand.RunGoalUpdate : FlowCommand.RunPauseWithdraw,
        expect.objectContaining({taskId: 'root', expectedEpoch: 7, requestId: f.saved()[0].context.operationId}));
});

it('does not send a pause after a fresh snapshot changes its epoch', async () => {
    vi.spyOn(Toast, 'error').mockImplementation(() => {});
    const f = await fixture(), {root} = await f.open();
    f.execute.mockResolvedValue(snapshot({mode: 'run', epoch: 4})); click(root, 'pause');
    await vi.waitFor(() => expect(f.saved()[0]?.status).toBe('unknown'));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RunGoalUpdate)).toBe(false);
});

it.each(['hide', 'destroy'] as const)('does not send when %s happens during registration', async action => {
    let release!: () => void;
    const operations = createOperationLedger({save: async () => new Promise<void>(resolve => {release = resolve;})});
    const execute = vi.fn(async (_name: string) => snapshot()), root = document.createElement('div');
    const view = new DagWorkbench(root, {commands: {execute} as never, operations: async () => operations}); views.push(view);
    await view.openRun('root', 's'); click(root, 'pause');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (action === 'hide') view.setVisible(false); else view.destroy();
    const registered = release; registered();
    await vi.waitFor(() => expect(release).not.toBe(registered)); release();
    await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('unknown'));
    expect(execute.mock.calls.some(([name]) => name === FlowCommand.RunGoalUpdate)).toBe(false);
});

it('loads and saves the standalone editor controls through the existing Session repository', async () => {
    let revision = 0, uiState: any = {};
    const repository = {getManifest: vi.fn(async () => ({revision, uiState})),
        compareAndSetUIState: vi.fn(async (_id: string, expected: number, patch: any) => {
            expect(expected).toBe(revision); uiState = structuredClone({...uiState, ...patch}); revision++;
        })};
    const execute = vi.fn(async (name: string) => name === FlowCommand.Presentations ? [] : snapshot());
    const root = document.createElement('div');
    const editor = new FlowsEditor({commands: {execute} as never, sessionRepository: repository as never});
    try {
        await editor.init(root); await (editor as any).workbench.openRun('root', 's'); click(root, 'pause');
        await vi.waitFor(() => expect(uiState.operationRecords?.[0]?.status).toBe('accepted'));
        expect(repository.compareAndSetUIState).toHaveBeenCalled();
        expect(uiState.operationRecords[0].conversationId).toBe('s');
    } finally {await editor.destroy();}
});

it('keeps cancel available if the control ledger cannot be read without enabling unpersisted pause', async () => {
    const error = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    const execute = vi.fn(async (_name: string, _args?: unknown) => snapshot()), root = document.createElement('div');
    const view = new DagWorkbench(root, {commands: {execute} as never, operations: async () => {throw new Error('Ledger unavailable');}});
    views.push(view); await view.openRun('root', 's');
    expect(error).toHaveBeenCalledWith('Ledger unavailable');
    expect(root.querySelector('[data-run-control="pause"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-run-action="cancel"]')!.click();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(FlowCommand.RunCancel, {taskId: 'root'}));
});

it('keeps read-only details free of control and ledger access', async () => {
    const operations = vi.fn(async () => createOperationLedger()), root = document.createElement('div');
    const view = new DagWorkbench(root, {commands: {execute: async () => snapshot()} as never, operations, readOnly: true});
    views.push(view); await view.openRun('root', 's');
    expect(operations).not.toHaveBeenCalled();
    expect(root.querySelector('[data-run-control]')).toBeNull();
    expect(root.querySelector('[data-run-action="cancel"]')).toBeNull();
});

it('distinguishes reattaching an active run from releasing a confirmed pause', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({...snapshot({mode: 'pause', epoch: 3, acknowledged: true}, true), attachedFromStorage: true});
    const {root} = await f.open();
    expect(root.querySelector('[data-run-action="resume"]')).toBeNull();
    expect(root.querySelector('[data-run-control="resume"]')).not.toBeNull();
    click(root, 'resume');
    await vi.waitFor(() => expect(f.saved()[0]?.status).toBe('accepted'));
    const commands = f.execute.mock.calls.map(([name]) => name);
    expect(commands.indexOf(FlowCommand.RunResume)).toBeLessThan(commands.indexOf(FlowCommand.RunGoalUpdate));
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand, SessionCommand } from '@itookit/llm-session';
import { DagWorkbench } from '../../llm-ui/src/components/DagWorkbench';
import { openSessionFlowOutputs } from '../../llm-ui/src/flows/session-output';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks(); });

function snapshot(status: string, output?: unknown) {
    const task = { id: 'root', sessionId: 's', status, program: { kind: 'flow.aggregate' }, attemptCount: 1, output };
    return { root: { task }, nodes: [], taskTree: [task, { ...task, id: 'child', labels: { dispatchKey: 'language' }, output: { outputs: { result: 0 } } }],
        iterations: {}, detachedNodes: [], usage: { tokens: 0, elapsedMs: 100 }, attachedFromStorage: true };
}

it('refreshes final and child outputs, restores persisted results, and stops after destruction', async () => {
    vi.useFakeTimers(); let current = snapshot('running');
    const execute = vi.fn(async () => current), root = document.createElement('div'); document.body.append(root);
    const commands = { execute } as unknown as ICommandBus;
    const view = new DagWorkbench(root, { commands }); await view.openRun('root', 's');
    expect(root.querySelector('.dag-output__value')?.textContent).toBe('0');
    current = snapshot('succeeded', { nodes: { report: { outputs: { result: { score: 9, safe: '<img src=x onerror=alert(1)>' } } } } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(root.textContent).toContain('"score": 9'); expect(root.querySelector('img')).toBeNull();
    view.destroy(); const count = execute.mock.calls.length; await vi.advanceTimersByTimeAsync(2000);
    expect(execute).toHaveBeenCalledTimes(count);
    const reopened = new DagWorkbench(root, { commands }); await reopened.openRun('root', 's');
    expect(root.textContent).toContain('"score": 9'); reopened.destroy();
});

it('shows only the current Session runs and closes on Session switch', async () => {
    const execute = vi.fn(async (command: string, args?: { sessionId?: string }) => {
        if (command === SessionCommand.FlowBranchExecutions) return { currentBranch: 'main', branches: [{ name: 'main', taskIds: ['root'] }] };
        if (command === FlowCommand.RunList) { expect(args?.sessionId).toBe('s'); return [
            { taskId: 'foreign', sessionId: 'other', name: 'foreign', status: 'succeeded' },
            { taskId: 'root', sessionId: 's', name: 'Review', status: 'succeeded' },
        ]; }
        return snapshot('succeeded', { nodes: { report: { outputs: { result: false } } } });
    });
    const abort = new AbortController(); openSessionFlowOutputs({ execute } as unknown as ICommandBus, 's', abort.signal);
    await vi.waitFor(() => expect(document.querySelector('.dag-output__value')?.textContent).toBe('false'));
    expect(document.querySelector('select')?.textContent).not.toContain('foreign');
    expect(execute.mock.calls.some(([command]) => command === FlowCommand.RunResume)).toBe(false);
    abort.abort(); expect(document.querySelector('dialog')).toBeNull();
});

it('switches output branches without changing History and clears output for empty branches', async () => {
    const execute = vi.fn(async (command: string, args?: any) => {
        if (command === SessionCommand.FlowBranchExecutions) return { currentBranch: 'new', branches: [
            { name: 'main', taskIds: ['old'], runs: [{ taskId: 'old', flowId: 'essay', revision: 1 }] }, { name: 'new', taskIds: ['new'], runs: [{ taskId: 'new', flowId: 'essay', revision: 2 }] }, { name: 'empty', taskIds: [] },
        ] };
        if (command === FlowCommand.RunList) return ['old', 'new', 'orphan'].map(taskId => ({ taskId, sessionId: 's', name: taskId, status: 'succeeded' }));
        return snapshot('succeeded', { nodes: { report: { outputs: { result: args.taskId } } } });
    });
    const abort = new AbortController(); openSessionFlowOutputs({ execute } as unknown as ICommandBus, 's', abort.signal);
    await vi.waitFor(() => expect(document.querySelector('.dag-output__value')?.textContent).toBe('new'));
    expect(document.querySelector('[data-run-action="resume"]')).toBeNull();
    expect(document.querySelector('[data-run-action="cancel"]')).toBeNull();
    const branch = document.querySelector<HTMLSelectElement>('[data-branch]')!;
    expect(document.querySelector('[data-run]')?.textContent).not.toContain('old');
    expect(document.querySelector('[data-run]')?.textContent).toContain('essay@v2');
    branch.value = 'main'; branch.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.dag-output__value')?.textContent).toBe('old'));
    expect(document.querySelector('[data-run]')?.textContent).not.toContain('new');
    expect(document.querySelector('[data-run]')?.textContent).toContain('essay@v1');
    branch.value = 'empty'; branch.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.dag-output__value')).toBeNull());
    expect(document.querySelector('[data-run]')?.textContent).toBe('');
    expect(execute.mock.calls.every(([command]) => [SessionCommand.FlowBranchExecutions, FlowCommand.RunList, FlowCommand.RunGet].includes(command as never))).toBe(true);
    abort.abort();
});

it('shows persisted variable values and task sources with escaped user content', async () => {
    const { renderVariables } = await import('../../llm-ui/src/components/dag/VariableView');
    const root = document.createElement('div');
    root.innerHTML = renderVariables({ ...snapshot('succeeded'), variables: {
        initial: { '': { essay: 'OLD' } }, snapshots: {},
        commits: [{ nodeId: 'rewrite', taskId: 'task-rewrite', scope: '', updates: { essay: '<img src=x onerror=alert(1)>' } }],
    } } as never);
    expect(root.textContent).toContain('OLD');
    expect(root.textContent).toContain('task-rewrite');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
});

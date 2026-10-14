// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Toast } from '@itookit/ui-common';
import { DagWorkbench } from '../../llm-ui/src/components/DagWorkbench';

function snapshot(retrying = false) {
    const original = { id: 'original', sessionId: 'session', status: 'failed', program: { kind: 'llm.agent' },
        labels: { flowNodeId: 'agent' }, attemptCount: 1, effects: {} };
    const next = { ...original, id: 'retry', retryOfTaskId: 'original', status: 'running' };
    return { root: { task: { id: 'root', sessionId: 'session', status: 'succeeded' } },
        nodes: [{ nodeId: 'agent', snapshot: { task: retrying ? next : original } }], iterations: { agent: retrying ? 2 : 1 },
        taskTree: retrying ? [original, next] : [original], detachedNodes: [], usage: { tokens: 1, startedAt: 0, elapsedMs: 1 } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('reuses a failed request identity and keeps polling the retry after the root finished', async () => {
    vi.useFakeTimers();
    vi.spyOn(Toast, 'error').mockImplementation(() => {});
    let retried = false;
    const execute = vi.fn(async (name: string) => {
        if (name === 'dag.run.task.retry') {
            if (!retried) { retried = true; throw new Error('response lost'); }
            return { targetTaskId: 'retry' };
        }
        return snapshot(retried);
    });
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root', 'session');
    expect(root.querySelector('[data-run-retry="original"]')).not.toBeNull();
    expect(root.querySelector('[data-run-retry="root"]')).toBeNull();
    await (workbench as any).retryRunTask('original');
    await (workbench as any).retryRunTask('original');
    const calls = execute.mock.calls.filter(([name]) => name === 'dag.run.task.retry') as unknown as Array<[string, any]>;
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[0][1]).toMatchObject({ sessionId: 'session', taskId: 'root', targetTaskId: 'original' });
    expect(root.querySelector('[data-task-id="retry"]')?.textContent).toContain('original');
    expect(root.querySelector('[data-run-retry="retry"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    workbench.destroy();
});

it('disables duplicate requests while a retry response is pending', async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn((name: string) => name === 'dag.run.task.retry'
        ? new Promise(done => { resolve = done; }) : Promise.resolve(snapshot()));
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root');
    const pending = (workbench as any).retryRunTask('original');
    expect(root.querySelector<HTMLButtonElement>('[data-run-retry="original"]')!.disabled).toBe(true);
    await (workbench as any).retryRunTask('original');
    expect(execute.mock.calls.filter(([name]) => name === 'dag.run.task.retry')).toHaveLength(1);
    resolve({ targetTaskId: 'retry' }); await pending;
    workbench.destroy();
});

it('renders each waiting task and pins an open response dialog to its original run', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
    const waiting = snapshot(true);
    waiting.taskTree = waiting.taskTree.map(task => ({ ...task, status: 'waiting',
        interactions: { answer: { id: 'answer', status: 'pending', prompt: task.id } } }));
    const execute = vi.fn(async (name: string, args: any) => name === 'dag.run.get'
        ? { ...waiting, root: { task: { ...waiting.root.task, id: args.taskId } } } : {});
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root', 'session');
    expect(root.querySelectorAll('[data-run-respond]')).toHaveLength(2);
    root.querySelector<HTMLButtonElement>('[data-run-respond="original"]')!.click();
    const dialog = document.body.querySelector('dialog')!;
    await workbench.openRun('other', 'session');
    dialog.querySelector('textarea')!.value = 'approved';
    dialog.returnValue = 'respond'; dialog.dispatchEvent(new Event('close'));
    expect(execute).toHaveBeenCalledWith('dag.run.respond', {
        taskId: 'root', targetTaskId: 'original', requestId: 'answer', value: 'approved',
    });
    workbench.destroy();
});

it('keeps goal edits on the original run after switching views and reports save failures', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
    const error = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    const execute = vi.fn(async (name: string, args: any) => {
        if (name === 'dag.run.goal.update') throw new Error('goal conflict');
        const run = snapshot(); return { ...run, root: { task: { ...run.root.task, id: args.taskId } } };
    });
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root', 'session');
    root.querySelector<HTMLButtonElement>('[data-run-action="goal"]')!.click();
    const dialog = document.body.querySelector('dialog')!;
    await workbench.openRun('other', 'session');
    dialog.querySelector('textarea')!.value = 'original objective';
    dialog.returnValue = 'save'; dialog.dispatchEvent(new Event('close'));
    expect(execute).toHaveBeenCalledWith('dag.run.goal.update', { taskId: 'root',
        goal: { objective: 'original objective', status: 'active' } });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('goal conflict'));
    workbench.destroy();
});

it('keeps polling workspace cleanup after tasks finish and renders cleanup failures safely', async () => {
    vi.useFakeTimers();
    let workspaceFinalization: any = { status: 'pending' };
    const execute = vi.fn(async () => ({ ...snapshot(), workspaceFinalization }));
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root');
    expect(root.querySelector('[data-workspace-status="pending"]')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    workspaceFinalization = { status: 'failed', message: '<img src=x onerror=alert(1)>' };
    await (workbench as any).refreshRun('root');
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(workspaceFinalization.message);
    expect(root.querySelector('img')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    workbench.destroy();
});

it('shows a status persistence error alongside the successful workspace cleanup result', async () => {
    const execute = vi.fn(async () => ({ ...snapshot(), workspaceFinalization: {
        status: 'succeeded', persistenceError: '<script>storage</script>',
    } }));
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root');
    expect(root.querySelector('[data-workspace-status="succeeded"]')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('<script>storage</script>');
    expect(root.querySelector('script')).toBeNull();
    workbench.destroy();
});

/** A Run that has not finished can still recompute downstream nodes. */
function resumableSnapshot() {
    const task = { id: 'original', sessionId: 'session', status: 'failed', program: { kind: 'llm.agent' },
        labels: { flowNodeId: 'agent' }, attemptCount: 1, effects: {} };
    return { root: { task: { id: 'root', sessionId: 'session', status: 'waiting' } },
        nodes: [{ nodeId: 'agent', snapshot: { task } }], iterations: { agent: 1 },
        taskTree: [task], detachedNodes: [], usage: { tokens: 1, startedAt: 0, elapsedMs: 1 } };
}

it('recomputes downstream only while the Run can still be resumed', async () => {
    const execute = vi.fn(async (name: string) => name === 'dag.run.task.retry'
        ? { targetTaskId: 'retry' } : resumableSnapshot());
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root', 'session');

    const button = root.querySelector<HTMLButtonElement>('[data-run-retry-downstream="original"]');
    expect(button).not.toBeNull();
    button!.click();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('dag.run.task.retry', expect.objectContaining({
        sessionId: 'session', taskId: 'root', targetTaskId: 'original', downstream: true,
    })));
    workbench.destroy();
});

it('hides the downstream recompute once the Run is terminal', async () => {
    const execute = vi.fn(async () => snapshot());
    const root = document.createElement('div');
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    await workbench.openRun('root', 'session');
    expect(root.querySelector('[data-run-retry-downstream="original"]')).toBeNull();
    expect(root.querySelector('[data-run-retry="original"]')).not.toBeNull();
    workbench.destroy();
});

it('opens persisted Runs from the visible history action and resumes the selected Run', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.dispatchEvent(new Event('close')); } });
    let resumed = false;
    const execute = vi.fn(async (name: string) => {
        if (name === 'plugin.dag.presentations') return [];
        if (name === 'dag.run.list') return [{ taskId: 'root', sessionId: 'session', name: '<saved run>', status: 'waiting', createdAt: 1 }];
        if (name === 'dag.run.resume') { resumed = true; return { taskId: 'root' }; }
        return { ...snapshot(), attachedFromStorage: !resumed };
    });
    const root = document.createElement('div'); document.body.append(root);
    const workbench = new DagWorkbench(root, { commands: { execute } as never });
    try {
        await workbench.initialize();
        root.querySelector<HTMLButtonElement>('[data-action="runs"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-run-index]')?.textContent).toContain('<saved run>'));
        expect(document.querySelector('saved')).toBeNull();
        document.querySelector<HTMLButtonElement>('[data-run-index]')!.click();
        await vi.waitFor(() => expect(root.querySelector('[data-mode="run"]')).not.toBeNull());
        expect(execute).toHaveBeenCalledWith('dag.run.get', { taskId: 'root', sessionId: 'session' });
        root.querySelector<HTMLButtonElement>('[data-run-action="resume"]')!.click();
        await vi.waitFor(() => expect(root.querySelector('[data-run-action="resume"]')).toBeNull());
        expect(execute).toHaveBeenCalledWith('dag.run.resume', { taskId: 'root', sessionId: 'session' });
        root.querySelector<HTMLButtonElement>('[data-run-action="back"]')!.click();
        expect(root.querySelector('[data-mode="design"]')).not.toBeNull();
    } finally { workbench.destroy(); root.remove(); }
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { DagWorkbench } from '../../llm-ui/src/components/DagWorkbench';

function pending() {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function snapshot(id: string, status = 'succeeded') {
    return { root: { task: { id, sessionId: 'session', status } }, nodes: [], iterations: {}, taskTree: [], detachedNodes: [],
        usage: { tokens: 0, startedAt: 0, elapsedMs: 0 } };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps the latest Run when open responses arrive out of order', async () => {
    const first = pending(), second = pending();
    const execute = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const workbench = new DagWorkbench(document.createElement('div'), { commands: { execute } as never });
    const render = vi.spyOn(workbench, 'render').mockImplementation(() => {});
    const a = workbench.openRun('a'), b = workbench.openRun('b');
    second.resolve(snapshot('b')); await b;
    first.resolve(snapshot('a')); await a;
    expect((workbench as any).run.root.task.id).toBe('b');
    expect(render).toHaveBeenCalledOnce();
    workbench.destroy();
});

it.each(['resolve', 'reject'])('ignores an old refresh %s after another Run opens', async outcome => {
    vi.useFakeTimers();
    const old = pending();
    const execute = vi.fn().mockResolvedValueOnce(snapshot('a', 'running')).mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(snapshot('b', 'running'));
    const workbench = new DagWorkbench(document.createElement('div'), { commands: { execute } as never });
    vi.spyOn(workbench, 'render').mockImplementation(() => {});
    await workbench.openRun('a');
    vi.advanceTimersByTime(1000);
    await workbench.openRun('b');
    outcome === 'resolve' ? old.resolve(snapshot('a')) : old.reject(new Error('old failure'));
    await Promise.resolve();
    expect((workbench as any).run.root.task.id).toBe('b');
    expect(vi.getTimerCount()).toBe(1);
    workbench.destroy();
});

it('does not render an opening Run after destruction', async () => {
    const load = pending();
    const workbench = new DagWorkbench(document.createElement('div'), { commands: { execute: () => load.promise } as never });
    const render = vi.spyOn(workbench, 'render').mockImplementation(() => {});
    const opening = workbench.openRun('a');
    workbench.destroy();
    load.resolve(snapshot('a')); await opening;
    expect(render).not.toHaveBeenCalled();
});

it('keeps the selected draft when an earlier Run request fails', async () => {
    const load = pending();
    const workbench = new DagWorkbench(document.createElement('div'), { commands: { execute: () => load.promise } as never });
    vi.spyOn(workbench, 'render').mockImplementation(() => {});
    const opening = workbench.openRun('a');
    workbench.setDraft({ id: 'draft', nodes: [], edges: [] } as never);
    load.reject(new Error('obsolete Run failure'));
    await expect(opening).resolves.toBeUndefined();
    expect((workbench as any).mode).toBe('design');
    workbench.destroy();
});

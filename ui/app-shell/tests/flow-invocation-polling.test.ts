// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand, FlowInvocationCommand } from '@itookit/llm-session';
import { InvocationPanel } from '../../llm-ui/src/flows/InvocationPanel';

let panel: InvocationPanel | undefined;
afterEach(() => { panel?.destroy(); panel = undefined; vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('polls idle calls slowly, refreshes on focus, and resumes fast polling for active calls', async () => {
    vi.useFakeTimers();
    let populated = false, status = 'running';
    const execute = vi.fn(async (command: string) => {
        if (command === FlowInvocationCommand.List) return populated
            ? [{ requestId: 'call', rootTaskId: 'task', flow: { name: 'Flow' }, revision: 1 }] : [];
        if (command === FlowCommand.RunGet) return { root: { task: { status } }, taskTree: [] };
        throw new Error(command);
    });
    panel = new InvocationPanel({ execute } as unknown as ICommandBus, 's', document.body, vi.fn());
    await panel.refresh(); expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000); expect(execute).toHaveBeenCalledTimes(1);
    populated = true;
    window.dispatchEvent(new Event('focus')); await panel.refresh();
    expect(document.querySelectorAll('[data-invocation]')).toHaveLength(1);
    execute.mockClear(); await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
    status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    execute.mockClear(); await vi.advanceTimersByTimeAsync(29_000);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(execute).toHaveBeenCalledTimes(2);
    panel.destroy(); execute.mockClear();
    window.dispatchEvent(new Event('focus')); await panel.refresh(); await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).not.toHaveBeenCalled();
});

it('keeps retrying failed loads and does not render a response after destruction', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown[]) => void;
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(() => new Promise(done => { resolve = done; }));
    panel = new InvocationPanel({ execute } as unknown as ICommandBus, 's', document.body, vi.fn());
    await panel.refresh(); await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
    const pending = panel.refresh(); panel.destroy();
    resolve([{ requestId: 'late', flow: { name: 'Late' }, error: 'failed' }]); await pending;
    expect(document.querySelector('[data-invocation]')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); expect(execute).toHaveBeenCalledTimes(2);
});

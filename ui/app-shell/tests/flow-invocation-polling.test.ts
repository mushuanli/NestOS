// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand, FlowInvocationCommand } from '@itookit/llm-session';
import { t } from '@itookit/common';
import { InvocationPanel } from '../../llm-ui-adapter/src/flows/InvocationPanel';

vi.mock('../../llm-ui-adapter/src/components/mdx/MDxController', () => ({
    MDxController: class {
        constructor(private root: HTMLElement, private text: string) {}
        async waitUntilReady() {this.root.textContent = this.text;}
        setContent(text: string) {this.text = text; this.root.textContent = text;}
        async destroy() {this.root.replaceChildren();}
    },
}));

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

it('suspends hidden flow panels without stopping their runs and refreshes on return', async () => {
    vi.useFakeTimers(); const execute = vi.fn(async () => []);
    panel = new InvocationPanel({execute} as unknown as ICommandBus, 's', document.body, vi.fn());
    await panel.refresh(); execute.mockClear(); panel.setVisible(false);
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).not.toHaveBeenCalled(); panel.setVisible(true); await panel.refresh();
    expect(execute).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith(FlowInvocationCommand.List, {sessionId: 's'});
});

it('distinguishes pause, continue and reattachment, and keeps action buttons stable during streaming updates', async () => {
    let paused = false, stored = false;
    const execute = vi.fn(async (command: string, input?: any) => {
        if (command === FlowInvocationCommand.List) return [{requestId: 'call', rootTaskId: 'root', flow: {name: 'Flow'}, revision: 1}];
        if (command === FlowCommand.RunGet) return {root: {task: {id: 'root', status: 'running', effects: {}, input: {initialScheduler: {controlTreeVersion: 1}}, control:
            {mode: paused ? 'pause' : 'run', epoch: 1, acknowledged: true}}}, taskTree: [], controlTaskIds: ['root'], controlStats: {root: {stopped: paused}}, attachedFromStorage: stored};
        if (command === FlowCommand.RunGoalUpdate) {paused = input.goal.status === 'paused'; return {};}
        throw new Error(command);
    });
    panel = new InvocationPanel({execute} as unknown as ICommandBus, 's', document.body, vi.fn());
    await panel.refresh();
    const button = (key: Parameters<typeof t>[0]) => [...document.querySelectorAll<HTMLButtonElement>('[data-actions] button')].find(button => button.textContent === t(key));
    const pause = button('flow.invoke.pause')!;
    expect(button('flow.invoke.reattach')).toBeUndefined();
    await panel.refresh(); expect(button('flow.invoke.pause')).toBe(pause);
    pause.click(); await vi.waitFor(async () => {await panel!.refresh(); expect(button('flow.invoke.continue')).toBeDefined();});
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.paused'));
    button('flow.invoke.continue')!.click(); await vi.waitFor(async () => {await panel!.refresh(); expect(button('flow.invoke.pause')).toBeDefined();});
    stored = true; await vi.waitFor(async () => {await panel!.refresh(); expect(button('flow.invoke.reattach')).toBeDefined();});
});

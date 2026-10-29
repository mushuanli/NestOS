import {afterEach, expect, it, vi} from 'vitest';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {recoverFlowSchedulers} from '../src/runtime/flow-scheduler-recovery';

afterEach(() => vi.useRealTimers());
function fixture() {
    const root = {id: 'root', program: {kind: 'flow.aggregate'}, labels: {kind: 'flow-root'}, status: 'waiting', state: {awaitingSchedule: true}};
    const kernel = {async *listSessions() {yield {id: 's', status: 'open'};}, listSessionTasks: vi.fn(async () => [root])};
    return {root, kernel};
}
it('waits out an existing scheduler lease and retries the same root without replaying input', async () => {
    vi.useFakeTimers(); const f = fixture();
    const execute = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Owned'), {code: 'FLOW_SCHEDULER_BUSY'})).mockResolvedValue({taskId: 'root'});
    const close = await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => true);
    expect(execute).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([command, input]) => command === FlowCommand.RunResume && input.taskId === 'root' && input.sessionId === 's')).toBe(true);
    close(); expect(vi.getTimerCount()).toBe(0);
});
it('does not take read-only Sessions, resume completed roots, or retry after host disposal', async () => {
    vi.useFakeTimers(); const f = fixture(), execute = vi.fn().mockRejectedValue(Object.assign(new Error('Owned'), {code: 'FLOW_SCHEDULER_BUSY'}));
    (await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => false))(); expect(execute).not.toHaveBeenCalled();
    f.root.status = 'succeeded'; (await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => true))(); expect(execute).not.toHaveBeenCalled();
    f.root.status = 'waiting'; const close = await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => true);
    close(); await vi.advanceTimersByTimeAsync(60000); expect(execute).toHaveBeenCalledTimes(1);
});
it('waits for the Session writer lease before reattaching its original Flow root', async () => {
    vi.useFakeTimers(); const f = fixture(), execute = vi.fn(async () => ({taskId: 'root'}));
    const writable = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const close = await recoverFlowSchedulers(f.kernel as never, {execute} as never, writable);
    expect(execute).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledWith(FlowCommand.RunResume, {sessionId: 's', taskId: 'root'});
    close(); expect(vi.getTimerCount()).toBe(0);
});

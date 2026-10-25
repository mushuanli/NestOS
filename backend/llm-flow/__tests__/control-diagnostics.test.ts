import {FlowDispatchGate} from '../src/flow/dispatch-gate';
import {expect, it, vi} from 'vitest';
import {traceFlowRetry, traceFlowRunControl} from '../src/flow/control-diagnostics';

const request = {requestId: 'operation', sessionId: 'session', taskId: 'root', targetTaskId: 'target'};

it('reports exact control identities and typed rejection without logging payloads or exception messages', async () => {
    const report = vi.fn(), error = Object.assign(new Error('PRIVATE-PROMPT'), {code: 'FLOW_RUN_TERMINAL'});
    await expect(traceFlowRetry({...request, payload: 'PRIVATE-CONTENT'} as never, report, async () => {throw error;})).rejects.toBe(error);
    expect(report).toHaveBeenCalledWith({operation: 'flow.task.retry', stage: 'control', outcome: 'error', mode: 'task',
        operationId: 'operation', sessionId: 'session', rootTaskId: 'root', targetTaskId: 'target', code: 'FLOW_RUN_TERMINAL', durationMs: expect.any(Number)});
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE');
});

it('does not change a committed control result when diagnostics fail', async () => {
    const operation = vi.fn(async () => 'accepted');
    expect(await traceFlowRetry(request, () => {throw new Error('LOGGER_FAILED');}, operation)).toBe('accepted');
    expect(operation).toHaveBeenCalledOnce();
});

it('reports bounded legacy recovery identities and duration through the existing diagnostic callback', async () => {
    const report = vi.fn(), input = {requestId: 'control', sessionId: 'session', rootTaskId: 'root', mode: 'resume' as const};
    await traceFlowRunControl(input, report, async () => ({limitedRecovery: true, retainedTaskIds: ['member']}));
    expect(report).toHaveBeenCalledWith({operation: 'flow.run.resume', stage: 'legacy-recovery', outcome: 'accepted', mode: 'resume',
        operationId: 'control', sessionId: 'session', rootTaskId: 'root', durationMs: expect.any(Number), code: 'FLOW_LEGACY_CONTROL_RECOVERY', retainedCount: 1});
});

it('does not leak control failure text or change a committed result when its diagnostic callback throws', async () => {
    const input = {requestId: 'control', sessionId: 'session', rootTaskId: 'root', mode: 'withdraw' as const}, report = vi.fn();
    const error = Object.assign(new Error('PRIVATE-ANSWER'), {code: 'CONFLICT'});
    await expect(traceFlowRunControl(input, report, async () => {throw error;})).rejects.toBe(error);
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE');
    expect(await traceFlowRunControl(input, () => {throw new Error('PRIVATE-LOGGER');}, async () => 'accepted')).toBe('accepted');
});


it('does not fail dispatch when logging a held or released barrier throws', async () => {
    let reads = 0;
    const report = vi.spyOn(console, 'debug').mockImplementation(() => {throw new Error('LOGGER_FAILED');});
    try {
        const gate = new FlowDispatchGate({session: {id: 'session'} as never,
            root: {id: 'root', status: async () => ({task: {status: 'running', sessionPaused: reads++ === 0}})} as never,
            isDisposed: () => false, assertOwned: async () => {}});
        expect(await gate.wait()).toBe(true);
        expect(report).toHaveBeenCalledTimes(2);
    } finally {report.mockRestore();}
});

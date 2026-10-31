import {expect, it, vi} from 'vitest';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import type {IndependentCallInput, IndependentCallReceipt, IndependentCallView} from '@itookit/llm-session/contracts';
import {IndependentCallCommand} from '@itookit/llm-session/contracts';
import {waitIndependentCall} from '../src/independent-call-execution';
const input = {request: {expectedBranch: 'main'}} as IndependentCallInput;
const receipt: IndependentCallReceipt = {operationId: 'call', callerSessionId: 'parent', executionSessionId: 'child', status: 'accepted'};
function fixture(states: object[]) {
    const stop = vi.fn(), execute = vi.fn(async () => [{receipt, ...states.shift()}] as IndependentCallView[]);
    const client = {services: {commandBus: {execute}, sessionManager: {onEvent: vi.fn(() => stop)}}} as unknown as ApplicationClient;
    return {client, execute, stop};
}
it('waits for dispatch, descendant cleanup, caller settlement and committed history', async () => {
    const f = fixture([
        {callerState: {exitStatus: 'succeeded', settled: true}},
        {executionState: {exitStatus: 'succeeded'}, executionTree: {settled: false}},
        {executionState: {exitStatus: 'succeeded'}, historyPending: true},
        {executionState: {exitStatus: 'succeeded'}, callerState: {settled: false}},
        {executionState: {exitStatus: 'succeeded'}, callerState: {settled: true}, historyPending: false},
    ]);
    expect(await waitIndependentCall(f.client, input, receipt, true)).toMatchObject({execution: {status: 'completed'}});
    expect(f.execute).toHaveBeenCalledTimes(5); expect(f.stop).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledWith(IndependentCallCommand.List, {sessionId: 'parent', branchId: 'main'});
});
it('reports a failed caller before target dispatch without waiting for nonexistent history', async () => {
    const f = fixture([{callerState: {exitStatus: 'failed', settled: true}, historyPending: true}]);
    expect(await waitIndependentCall(f.client, input, receipt)).toMatchObject({execution: {status: 'failed'}});
});
it.each([
    [{interactions: {total: 1}}, {waitingForInput: true}],
    [{executionState: {control: {requested: 'pause'}, stopped: true}}, {waitingForDispatch: true}],
])('returns the shared pending state without reading ordinary submission history', async (state, expected) => {
    const f = fixture([state]);
    expect(await waitIndependentCall(f.client, input, receipt)).toMatchObject({execution: expected});
});
it('rejects a changed execution scope and releases its observer', async () => {
    const f = fixture([{receipt: {...receipt, executionSessionId: 'other'}}]);
    await expect(waitIndependentCall(f.client, input, receipt, true)).rejects.toMatchObject({code: 'CLI_CALL_OBSERVATION_CONFLICT'});
    expect(f.stop).toHaveBeenCalledOnce();
});

import type {ApplicationClient} from '@itookit/app-contracts/services';
import {IndependentCallCommand, type IndependentCallInput, type IndependentCallReceipt, type IndependentCallView} from '@itookit/llm-session/contracts';

/** Observe the same durable projection as the Web call panel, independently of view binding. */
export async function waitIndependentCall(client: ApplicationClient, input: IndependentCallInput, receipt: IndependentCallReceipt, follow = false) {
    const stop = follow ? client.services.sessionManager.onEvent(event => process.stdout.write(JSON.stringify(event) + '\n')) : () => {};
    try {return await observeCall(client, input, receipt);} finally {stop();}
}

async function observeCall(client: ApplicationClient, input: IndependentCallInput, receipt: IndependentCallReceipt) {
    while (true) {
        const calls = await client.services.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List,
            {sessionId: receipt.callerSessionId, branchId: input.request.expectedBranch});
        const call = calls.find(item => item.receipt.operationId === receipt.operationId);
        if (!call || call.receipt.executionSessionId !== receipt.executionSessionId)
            throw Object.assign(new Error('Independent call observation scope differs from admission'), {code: 'CLI_CALL_OBSERVATION_CONFLICT'});
        const state = call.executionState ?? call.callerState;
        const exit = call.executionState?.exitStatus ?? (call.callerState?.exitStatus !== 'succeeded' ? call.callerState?.exitStatus : undefined);
        const waitingForInput = !!call.interactions?.total;
        const waitingForDispatch = state?.control?.requested === 'pause' && !!state.stopped;
        const settled = !call.executionTree || call.executionTree.settled;
        if (waitingForInput || waitingForDispatch || exit && settled && (!call.executionState || !call.historyPending) && (!call.callerState || call.callerState.settled)) {
            return {executionRef: call.receipt.execution, execution: {
                status: exit === 'succeeded' ? 'completed' : exit ?? 'waiting', rootTaskId: call.receipt.execution?.taskId,
                invocationId: call.receipt.execution?.invocation?.invocationId, waitingForInput, waitingForDispatch}, waitingForInput};
        }
        await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
}

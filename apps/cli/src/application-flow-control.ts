import type {ApplicationClient} from '@itookit/app-contracts/services';
import {FlowCommand, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import {recordRuntimeDiagnostic} from './diagnostics';

const actions = ['show', 'receipt', 'pause', 'resume', 'withdraw-pause', 'cancel', 'reattach'];

/** Explicit caller-owned identities survive CLI process loss; no control is automatically replayed. */
export async function flowControlCommand(client: ApplicationClient, args: string[]): Promise<unknown> {
    const input = parseControl(args), started = Date.now(), bus = client.services.commandBus;
    try {
        const snapshot = await bus.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: input.sessionId, taskId: input.taskId});
        if (input.action === 'show') return snapshot;
        if (input.action === 'receipt') return {requestId: input.requestId,
            outcome: snapshot.root.task.control?.requestId === input.requestId ? 'observed' : 'unknown',
            control: snapshot.root.task.control, stat: snapshot.controlStats?.[input.taskId]};
        const result = await dispatchControl(bus, input);
        diagnose(input, started);
        return result;
    } catch (error) {diagnose(input, started, error); throw error;}
}

type Input = ReturnType<typeof parseControl>;
function parseControl(args: string[]) {
    const [action, sessionId, taskId, requestId, epoch] = args;
    const versioned = ['pause', 'resume', 'withdraw-pause'].includes(action);
    const count = versioned ? 5 : action === 'receipt' ? 4 : 3;
    if (!actions.includes(action) || args.length !== count || args.some(value => !value.trim()))
        throw invalid('flow-run requires an action, session id, root task id, and for controls a request id and observed epoch');
    if (requestId && requestId.length > 256) throw invalid('Control request id exceeds 256 characters');
    if (versioned && (!/^(0|[1-9][0-9]*)$/.test(epoch) || !Number.isSafeInteger(Number(epoch))))
        throw invalid('Control epoch must be a nonnegative safe integer');
    return {action, sessionId, taskId, requestId, expectedEpoch: versioned ? Number(epoch) : undefined};
}

function dispatchControl(bus: ApplicationClient['services']['commandBus'], input: Input) {
    const {action, sessionId, taskId, requestId, expectedEpoch} = input;
    if (action === 'cancel' || action === 'reattach') return bus.execute(action === 'cancel' ? FlowCommand.RunCancel : FlowCommand.RunResume, {sessionId, taskId});
    if (action === 'withdraw-pause') return bus.execute(FlowCommand.RunPauseWithdraw, {taskId, requestId, expectedEpoch});
    return bus.execute(FlowCommand.RunGoalUpdate, {taskId, requestId, expectedEpoch, goal: {status: action === 'pause' ? 'paused' : 'active'}});
}

function invalid(message: string) {return Object.assign(new Error(message), {code: 'FLOW_CONTROL_REQUEST_INVALID'});}
function diagnose(input: Input, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    try {recordRuntimeDiagnostic('flow.control', {operation: `flow-run.${input.action}`, stage: 'command',
        operationId: input.requestId && /^[\w:.-]{1,256}$/.test(input.requestId) ? input.requestId : undefined,
        outcome: error ? 'error' : 'accepted', durationMs: Date.now() - started,
        ...(error ? {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_CONTROL_FAILED'} : {})});}
    catch { /* Diagnostics must not change the control result. */ }
}

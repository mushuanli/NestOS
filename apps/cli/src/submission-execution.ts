import type {ApplicationClient} from '@itookit/app-contracts/services';
import {SessionCommand, type Round, type SessionInstructionQueue, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import type {DurableFlowSnapshot} from '@itookit/llm-flow/contracts';

interface SubmissionExecution {
    status: Round['status'] | 'queued' | 'unknown';
    rootTaskId?: string;
    invocationId?: string;
    waitingForInput: boolean;
    waitingForDispatch?: boolean;
    needsReconciliation?: boolean;
}

/** Session notifications wake an observer; only this submission's durable facts decide completion. */
export function watchSubmissionExecution(client: ApplicationClient, request: SubmissionRequest, follow = false) {
    let revision = 0, wake: (() => void) | undefined;
    const changed = () => {++revision; wake?.();};
    const stopGlobal = client.services.sessionManager.onGlobalEvent(event => {
        if ('sessionId' in event.payload && event.payload.sessionId === request.expectedSessionId) changed();
    });
    const stopEvents = client.services.sessionManager.onEvent(event => {
        if (follow) process.stdout.write(JSON.stringify(event) + '\n');
        if (event.type === 'await_signal') changed();
    });
    return {
        wait: async (): Promise<SubmissionExecution> => {
            while (true) {
                const observed = revision, state = await readExecution(client, request);
                if (['completed', 'failed', 'cancelled'].includes(state.status) || state.waitingForInput || state.waitingForDispatch || state.needsReconciliation) return state;
                if (observed !== revision) continue;
                await new Promise<void>(resolve => {
                    const timer = setTimeout(() => wake?.(), 1000);
                    wake = () => {clearTimeout(timer); wake = undefined; resolve();};
                });
            }
        },
        dispose: () => {stopEvents(); stopGlobal(); wake?.();},
    };
}

async function readExecution(client: ApplicationClient, request: SubmissionRequest): Promise<SubmissionExecution> {
    const id = request.expectedSessionId!, submission = request.submission!;
    const raw = await client.services.sessionRepository.readDocument(id, `round-${submission.id}.json`);
    if (!raw) return readQueuedExecution(client, request);
    const round = JSON.parse(raw) as Round;
    assertRoundSubmission(round, request);
    const primary = round.executions.find(execution => execution.role === 'primary');
    const state: SubmissionExecution = {status: round.status, rootTaskId: primary?.taskId, invocationId: primary?.invocation?.invocationId, waitingForInput: false};
    if (['completed', 'failed', 'cancelled'].includes(round.status)) return state;
    state.waitingForInput = await pendingForRound(client, id, round);
    return state;
}

async function readQueuedExecution(client: ApplicationClient, request: SubmissionRequest): Promise<SubmissionExecution> {
    const queue = await client.services.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    if (queue.sessionId !== request.expectedSessionId) throw new Error('Session changed while observing a submitted call');
    const item = queue.items.find(item => item.id === request.submission!.id);
    return {status: item?.state === 'failed' ? 'failed' : item ? 'queued' : 'unknown', waitingForInput: false,
        waitingForDispatch: !!item && queue.paused, needsReconciliation: !item || item.state === 'uncertain'};
}

function assertRoundSubmission(round: Round, request: SubmissionRequest): void {
    const expected = request.submission!, actual = round.submission;
    const matched = round.id === expected.id && round.sessionId === request.expectedSessionId && actual?.id === expected.id;
    if (!matched || !actual || !['kind', 'ownerId', 'id'].every(key => actual.source[key as keyof typeof actual.source] === expected.source[key as keyof typeof expected.source]))
        throw Object.assign(new Error('Submission history identity differs from the observed call'), {code: 'CLI_CALL_HISTORY_CONFLICT'});
}

async function pendingForRound(client: ApplicationClient, id: string, round: Round): Promise<boolean> {
    const pending = await client.services.kernel.kernel.listSessionPendingInteractionTasks(id);
    if (!pending.length) return false;
    const roots = new Set(round.executions.map(execution => execution.taskId));
    if (round.flow) for (const execution of round.executions) {
        const snapshot = await client.services.commandBus.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: id, taskId: execution.taskId});
        for (const taskId of snapshot.controlTaskIds ?? []) roots.add(taskId);
    }
    return pending.some(task => (roots.has(task.id) || roots.has(task.rootTaskId)) && !task.exit
        && Object.values(task.interactions).some(interaction => interaction.status === 'pending'));
}

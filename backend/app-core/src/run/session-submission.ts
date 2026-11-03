import {SessionCommand, type SubmissionRequest, type Round, type ISessionRepository} from '@itookit/llm-session/contracts';
import {taskStat, type Kernel} from '@itookit/durable-kernel';
import type {ConversationContexts} from '../runtime/conversation-contexts';
import {failure} from './prompt-bundle';

interface Options {contexts: Pick<ConversationContexts, 'open'>; repository: Pick<ISessionRepository, 'readDocument'>;
    kernel: Pick<Kernel, 'task' | 'inspectSession'>; ensureWritable?(sessionId: string): Promise<boolean>}
function requireValue(value: unknown, code: string): asserts value {if (!value) throw failure(code);}
export interface SessionSubmissionObservation {sessionId: string; outcome: 'running' | 'unknown' | 'succeeded' | 'failed' | 'cancelled'; code?: string}
/** Recover the admitted Session and inspect durable facts without activating a view or replaying input. */
export function sessionSubmission(options: Options) {
    const inspect = async (request: SubmissionRequest): Promise<SessionSubmissionObservation> => {
        if (options.ensureWritable && !await options.ensureWritable(request.expectedSessionId!))
            return {sessionId: request.expectedSessionId!, outcome: 'unknown', code: 'SESSION_WRITER_UNAVAILABLE'};
        return inspectSubmission(options, request);
    };
    return {inspect, async start(request: SubmissionRequest) {
        requireValue(request.expectedSessionId && request.submission?.id && request.expectedBranch, 'SUBMISSION_INVALID');
        if (options.ensureWritable && !await options.ensureWritable(request.expectedSessionId))
            throw Object.assign(failure('SESSION_WRITER_UNAVAILABLE'), {executionOutcome: 'not-started', retryable: true});
        const lease = await options.contexts.open(request.expectedSessionId);
        try {await lease.commandBus.execute(SessionCommand.Submit, request);}
        catch (error) {
            if ((error as {code?: string})?.code === 'QUEUE_READ_ONLY')
                throw Object.assign(error as Error, {executionOutcome: 'not-started', retryable: true});
            throw error;
        }
        finally {await lease.dispose();}
        return inspect(request);
    }};
}
async function inspectSubmission(options: Options, request: SubmissionRequest): Promise<SessionSubmissionObservation> {
    const sessionId = request.expectedSessionId!, id = request.submission!.id;
    const raw = await options.repository.readDocument(sessionId, `round-${id}.json`);
    if (!raw) return {sessionId, outcome: 'unknown', code: 'SUBMISSION_RECEIPT_UNKNOWN'};
    const round = JSON.parse(raw) as Round;
    requireValue(round.id === id && round.sessionId === sessionId
        && JSON.stringify(round.submission) === JSON.stringify(request.submission), 'SUBMISSION_HISTORY_CONFLICT');
    if (!['completed', 'failed', 'cancelled'].includes(round.status)) {
        const lease = await options.contexts.open(sessionId);
        await lease.dispose();
    }
    const primary = round.executions.find(execution => execution.role === 'primary');
    if (!primary) return {sessionId, outcome: 'unknown', code: 'SUBMISSION_EXECUTION_MISSING'};
    const task = await options.kernel.task(sessionId, primary.taskId);
    requireValue(task.labels?.roundId === id, 'SUBMISSION_EXECUTION_CONFLICT');
    const snapshot = await (await options.kernel.inspectSession(sessionId)).snapshot();
    const tree = snapshot.tasks.filter(row => row.rootTaskId === task.rootTaskId);
    if (!taskStat(task).settled || tree.some(row => !taskStat(row).settled)) return {sessionId, outcome: 'running'};
    if (!task.exit || !['completed', 'failed', 'cancelled'].includes(round.status)) return {sessionId, outcome: 'unknown', code: 'SUBMISSION_SETTLEMENT_PENDING'};
    const outcome = task.exit.status === 'succeeded' ? 'succeeded' : task.exit.status === 'cancelled' ? 'cancelled' : 'failed';
    const code = (task.exit.error as {code?: string})?.code;
    return {sessionId, outcome, ...(outcome === 'failed' ? {code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SUBMISSION_EXECUTION_FAILED'} : {})};
}

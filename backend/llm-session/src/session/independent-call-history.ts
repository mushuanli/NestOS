import {sameTargetRef, isInvocationIdentity, type InvocationIdentity} from '@itookit/llm-flow/contracts';
import type {TaskRef} from '@itookit/durable-kernel';
import type {Round} from '../contracts/conversation';
import type {SubmissionRequest} from '../contracts/submission';
import type {ISessionRepository} from '../persistence/types';
import {hasMatchingCommittedSubmission} from '../persistence/submission-receipt';
import {instructionDigest, prepareInstruction} from './instruction-queue-rules';
import {submissionInstruction} from './submission-input';

/** An unindexed body cannot prove committed history, even after the Kernel has completed. */
export async function committedIndependentKernelHistory(repository: ISessionRepository, request: SubmissionRequest,
    invocation: InvocationIdentity, target: TaskRef | undefined, round: Round | undefined): Promise<Round | undefined> {
    if (!round) return;
    const sessionId = request.expectedSessionId!, branch = request.expectedBranch!;
    const digest = await instructionDigest(prepareInstruction(submissionInstruction(request), sessionId, branch));
    if (round.submissionDigest !== digest || !sameTargetRef(round.target, request.expectedTarget)) throw conflict();
    if (!primaryExecution(round, target, invocation)) return;
    return await hasMatchingCommittedSubmission(repository, sessionId, request.submission!, digest) ? round : undefined;
}
function primaryExecution(round: Round, target: TaskRef | undefined, invocation: InvocationIdentity) {
    const primary = round.executions.filter(item => item.role === 'primary');
    if (primary.length > 1) throw conflict();
    const actual = primary[0]; if (!actual) return;
    if (!target || actual.taskId !== target.taskId || !sameInvocation(actual.invocation, invocation)) throw conflict();
    return actual;
}
function sameInvocation(actual: InvocationIdentity | undefined, expected: InvocationIdentity): boolean {
    return isInvocationIdentity(actual) && actual.invocationId === expected.invocationId && actual.parentInvocationId === expected.parentInvocationId
        && actual.retryOfInvocationId === expected.retryOfInvocationId && actual.retryOfSessionId === expected.retryOfSessionId;
}
function conflict(): Error {return Object.assign(new Error('Kernel call history does not match the original execution'), {code: 'CALL_EXECUTION_CONFLICT'});}

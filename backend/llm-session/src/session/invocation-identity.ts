import type {DagRunSpec, FlowRevision, InvocationIdentity} from '@itookit/llm-flow/contracts';
import type {Kernel} from '@itookit/durable-kernel';
import type {ExecutionRef, Round} from '../contracts/conversation';
import type {ExecutionTask} from '../core/types';
import {ulid} from '../persistence/ulid';

export function conversationFlowInvocation(task: ExecutionTask, flow: FlowRevision): DagRunSpec['invocation'] {
    const identity = task.input.invocation;
    if (!identity) return;
    return {...identity, requestId: identity.invocationId, flowId: flow.id, revision: flow.revision, digest: flow.digest,
        ...(task.frozen?.config?.target ? {target: structuredClone(task.frozen.config.target)} : {}),
        name: flow.name, createdAt: task.createdAt, ...(task.frozen ? {branch: task.frozen.branchRef, head: task.frozen.branchHead} : {})};
}

/** A user rerun mints a call, while the prior Kernel task and its outcome remain unchanged. */
export async function newRerunInvocation(kernel: Pick<Kernel, 'openTask'>, sessionId: string, round?: Round): Promise<InvocationIdentity> {
    const previous = [...round?.executions ?? []].reverse().find(execution => execution.role === 'primary');
    if (!previous) return {invocationId: ulid()};
    const task = (await (await kernel.openTask(previous.taskId)).status()).task;
    if (task.sessionId !== sessionId || previous.invocation && task.labels?.invocationId
        && previous.invocation.invocationId !== task.labels.invocationId)
        throw Object.assign(new Error('Execution does not match the source invocation'), {code: 'INVOCATION_EXECUTION_CONFLICT'});
    if (!['succeeded', 'failed', 'cancelled'].includes(task.status))
        throw Object.assign(new Error('Reconcile or finish the original invocation before rerunning'), {code: 'INVOCATION_NOT_TERMINAL'});
    const originalId = previous.invocation?.invocationId ?? task.labels?.invocationId ?? legacyExecutionInvocationId(sessionId, previous);
    return {invocationId: ulid(), retryOfInvocationId: originalId, retryOfSessionId: sessionId};
}

export function legacyExecutionInvocationId(sessionId: string, execution: Pick<ExecutionRef, 'taskId'>): string {
    return `legacy-task:${encodeURIComponent(sessionId)}:${encodeURIComponent(execution.taskId)}`;
}

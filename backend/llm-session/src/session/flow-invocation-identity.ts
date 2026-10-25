import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import {sameTargetRef} from '@itookit/llm-flow/contracts';
import {flowInvocationId, type FlowInvocationInput, type FlowInvocationRecord} from '../contracts/flow-invocations';

export const FLOW_INVOCATION_PREFIX = 'flow.invocation.';
const keys: Array<keyof FlowInvocationInput> = ['sessionId', 'requestId', 'flowId', 'revision', 'parameters', 'source',
    'expectedSignature', 'inputSources', 'connectionBindings', 'connectionId', 'retryOfInvocationId', 'retryOfSessionId'];

/** Only request fields may cross ingress; persisted plans and execution identities are host-owned. */
export function flowInvocationRequest(input: FlowInvocationInput): FlowInvocationInput {
    assertRequestIdentity(input);
    if (typeof input.flowId !== 'string' || !input.flowId || !Number.isSafeInteger(input.revision) || input.revision < 1)
        throw invocationError('FLOW_INVOCATION_INVALID', 'Invalid Flow revision identity');
    if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters))
        throw invocationError('FLOW_INPUT_OBJECT_REQUIRED', 'Flow parameters must be an object');
    assertRerunIdentity(input);
    return structuredClone(Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]))) as unknown as FlowInvocationInput;
}

function assertRequestIdentity(input: FlowInvocationInput): void {
    if (!input || typeof input !== 'object' || typeof input.sessionId !== 'string' || !input.sessionId
        || typeof input.requestId !== 'string' || !/^[\w-]{1,128}$/.test(input.requestId))
        throw invocationError('FLOW_INVOCATION_INVALID', 'Invalid Flow invocation request identity');
}
function assertRerunIdentity(input: FlowInvocationInput): void {
    if (input.retryOfInvocationId !== undefined && !identity(input.retryOfInvocationId)
        || input.retryOfSessionId !== undefined && (!identity(input.retryOfSessionId) || !input.retryOfInvocationId))
        throw invocationError('FLOW_INVOCATION_RETRY_INVALID', 'Invalid rerun source identity');
}

export async function assertFlowRerun(kernel: Kernel, input: FlowInvocationInput, parentSessionId?: string): Promise<void> {
    if (!input.retryOfInvocationId) return;
    const sourceId = input.retryOfSessionId ?? input.sessionId;
    if (sourceId !== input.sessionId && parentSessionId !== sourceId)
        throw invocationError('FLOW_INVOCATION_OUTSIDE_SESSION', 'Rerun source must belong to this Session or its parent');
    const records = await kernel.listShared(sourceId, FLOW_INVOCATION_PREFIX);
    const source = records.map(entry => entry.value as unknown as FlowInvocationRecord)
        .find(record => record.sessionId === sourceId && flowInvocationId(record) === input.retryOfInvocationId);
    if (!source) throw invocationError('FLOW_INVOCATION_NOT_FOUND', 'Rerun source invocation was not found');
    const session = await kernel.inspectSession(sourceId), root = findFlowInvocationRoot(await session.listTasks(), source);
    if (!root || !['succeeded', 'failed', 'cancelled'].includes(root.status))
        throw invocationError('FLOW_INVOCATION_NOT_TERMINAL', 'Reconcile or finish the original invocation before rerunning');
}

export function findFlowInvocationRoot(tasks: readonly TaskRecord[], record: FlowInvocationRecord): TaskRecord | undefined {
    const roots = tasks.filter(task => task.labels?.kind === 'flow-root'
        && metadata(task)?.requestId === record.requestId);
    if (roots.length > 1) throw invocationError('FLOW_INVOCATION_EXECUTION_CONFLICT', 'Multiple executions claim this invocation');
    const root = roots[0], call = root && metadata(root);
    if (call && !matchesInvocation(call, record))
        throw invocationError('FLOW_INVOCATION_EXECUTION_CONFLICT', 'Execution does not match the admitted invocation');
    return root;
}

function matchesInvocation(call: NonNullable<ReturnType<typeof metadata>>, record: FlowInvocationRecord): boolean {
    if (call.flowId !== record.flowId || call.revision !== record.flow.revision || call.digest !== record.flow.digest) return false;
    if (call.invocationId !== record.invocationId || call.retryOfInvocationId !== record.retryOfInvocationId || !sameTargetRef(call.target, record.target)) return false;
    return call.retryOfInvocationId === undefined || call.retryOfSessionId === (record.retryOfSessionId ?? record.sessionId);
}

function metadata(task: TaskRecord) {
    return (task.input as {initialScheduler?: {spec?: import('@itookit/llm-flow/contracts').DagRunSpec}})?.initialScheduler?.spec?.invocation;
}
function identity(value: unknown): value is string {return typeof value === 'string' && value.length > 0 && value.length <= 1024;}
function invocationError(code: string, message: string): Error {return Object.assign(new Error(message), {code});}

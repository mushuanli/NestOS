import {sha256HexSync} from '@itookit/llm-context';
import {isInvocationIdentity, type InvocationIdentity} from '../contracts/flow';

/** Stable business identity; graph generations and Kernel attempt ids do not participate. */
export function childInvocationIdentity(parent: Pick<InvocationIdentity, 'invocationId'> | undefined,
    kind: 'node' | 'dispatch', key: string, occurrence: number): InvocationIdentity | undefined {
    if (!parent?.invocationId) return;
    if (!isInvocationIdentity({invocationId: parent.invocationId}) || !key || !Number.isSafeInteger(occurrence) || occurrence < 1)
        throw Object.assign(new Error('Invalid child invocation scope'), {code: 'FLOW_INVOCATION_SCOPE_INVALID'});
    const digest = sha256HexSync(JSON.stringify(['flow-child-invocation-v1', parent.invocationId, kind, key, occurrence]));
    return {invocationId: `flow-call:${digest}`, parentInvocationId: parent.invocationId};
}

export function invocationFromLabels(labels?: Record<string, string>): InvocationIdentity | undefined {
    if (!labels?.invocationId) return;
    const identity = Object.fromEntries(['invocationId', 'parentInvocationId', 'retryOfInvocationId', 'retryOfSessionId']
        .flatMap(key => labels[key] === undefined ? [] : [[key, labels[key]]]));
    return isInvocationIdentity(identity) ? identity : undefined;
}

export function flowNodeInvocation(version: 1 | undefined, parent: Partial<InvocationIdentity> | undefined,
    nodeId: string, iteration: number): InvocationIdentity | undefined {
    if (version !== 1 || !parent?.invocationId) return;
    return childInvocationIdentity({invocationId: parent.invocationId}, 'node', nodeId, iteration);
}

/** Do not upgrade or downgrade accepted Task fingerprints during recovery. */
export function assertInvocationCheckpoint(root: import('@itookit/durable-kernel').TaskRecord, version: 1 | undefined): void {
    const initial = (root.input as {initialScheduler?: {invocationIdentityVersion?: unknown}} | undefined)?.initialScheduler;
    if (initial?.invocationIdentityVersion !== version)
        throw Object.assign(new Error('Invocation identity protocol differs from the frozen Run'), {code: 'FLOW_INVOCATION_CHECKPOINT_MISMATCH'});
}

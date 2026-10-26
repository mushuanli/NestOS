import {prepareTaskCall} from '@itookit/llm-flow';
import {snapshotTaskCallPlan, type TaskSubmissionReceipt, type TaskCallPlan} from '@itookit/durable-kernel';
import {isInvocationIdentity, targetLabels, type InvocationIdentity, type TargetRef} from '@itookit/llm-flow/contracts';
import {sha256HexSync} from '@itookit/llm-context';
import type {SubmissionRequest} from '../contracts/submission';
import type {PreparedDirectConversationRun, PreparedConversationContext} from './conversation-preparation';
import {ulid} from '../persistence/ulid';

export interface IndependentTaskCallPolicy {maxDepth: number; timeoutMs?: number | null}
export interface IndependentTaskCallPreparation extends IndependentTaskCallPolicy {
    /** Trusted host preparation only; this callback cannot be supplied through RPC. */
    prepare(request: SubmissionRequest, invocation: InvocationIdentity): Promise<PreparedDirectConversationRun>;
}
export interface PreparedIndependentTaskCall {
    operationId: string; caller: {sessionId: string; requestId: string}; executionSessionId: string;
    invocation: InvocationIdentity; plan: TaskCallPlan; context: PreparedConversationContext;
}
/** Real Kernel admission; target execution and history completion are separate observations. */
export interface IndependentTaskCallAdmission {
    operationId: string;
    invocation: InvocationIdentity;
    executionSessionId: string;
    submission: TaskSubmissionReceipt;
}
interface PreparedData {plan: TaskCallPlan; context: PreparedConversationContext; digest: string}
export interface IndependentKernelPreparation {version: 1; callerRequestId: string; invocation: InvocationIdentity; policy: IndependentTaskCallPolicy; prepared?: PreparedData}
export interface PreparationScope {operationId: string; sessionId: string; roundId: string; target: TargetRef; branch: string}

/** Freeze host limits before asynchronous route discovery. */
export function snapshotIndependentTaskCallPolicy(policy: IndependentTaskCallPolicy): IndependentTaskCallPolicy {
    if (!policy) throw invalid('CALL_PREPARATION_POLICY_INVALID');
    const frozen = {maxDepth: policy.maxDepth, ...(policy.timeoutMs !== undefined ? {timeoutMs: policy.timeoutMs} : {})};
    assertPolicy(frozen); return frozen;
}
/** Allocate an Invocation only for a new route candidate; retries use the persisted winner. */
export function newIndependentKernelPreparation(policy: IndependentTaskCallPolicy, operationId: string): IndependentKernelPreparation {
    return {version: 1, callerRequestId: `independent-call:${operationId}`, invocation: {invocationId: ulid()}, policy: snapshotIndependentTaskCallPolicy(policy)};
}
export function assertIndependentPreparationMode(saved: IndependentKernelPreparation | undefined, requested?: IndependentTaskCallPolicy): void {
    if (!!saved !== !!requested) throw invalid('CALL_EXECUTION_MODE_CONFLICT');
    if (!saved || !requested) return;
    assertClaim(saved);
    if (JSON.stringify(saved.policy) !== JSON.stringify(requested)) throw invalid('CALL_PREPARATION_POLICY_CONFLICT');
}
export function freezeIndependentTaskCall(claim: IndependentKernelPreparation, scope: PreparationScope,
    ready: PreparedDirectConversationRun): PreparedData {
    assertClaim(claim);
    const plan = prepareTaskCall(ready.definition, claim.policy), context = structuredClone(ready.context);
    assertScope(plan, context, claim, scope);
    const data = JSON.parse(JSON.stringify({plan, context})) as Omit<PreparedData, 'digest'>;
    return {...data, digest: sha256HexSync(JSON.stringify(data))};
}
export function readIndependentTaskCall(claim: IndependentKernelPreparation, scope: PreparationScope): Omit<PreparedData, 'digest'> | undefined {
    assertClaim(claim);
    if (claim.callerRequestId !== `independent-call:${scope.operationId}`) throw invalid('CALL_PREPARATION_SCOPE_MISMATCH');
    const data = claim.prepared; if (!data) return;
    if (data.digest !== sha256HexSync(JSON.stringify({plan: data.plan, context: data.context}))) throw invalid('CALL_PREPARATION_CORRUPT');
    const plan = snapshotTaskCallPlan(data.plan); assertScope(plan, data.context, claim, scope);
    if (plan.maxDepth !== claim.policy.maxDepth || plan.timeoutMs !== claim.policy.timeoutMs) throw invalid('CALL_PREPARATION_POLICY_CONFLICT');
    return {plan, context: structuredClone(data.context)};
}
function assertClaim(value: IndependentKernelPreparation): void {
    if (!value || value.version !== 1 || !/^independent-call:[\w-]{1,128}$/.test(value.callerRequestId) || !isInvocationIdentity(value.invocation)) throw invalid('CALL_PREPARATION_CORRUPT');
    assertPolicy(value.policy);
}
function assertPolicy(value: IndependentTaskCallPolicy): void {
    if (!value || !Number.isSafeInteger(value.maxDepth) || value.maxDepth < 1 || value.timeoutMs !== undefined && value.timeoutMs !== null
        && (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0 || value.timeoutMs > 2_147_483_647)) throw invalid('CALL_PREPARATION_POLICY_INVALID');
}
function assertScope(plan: TaskCallPlan, context: PreparedConversationContext, claim: IndependentKernelPreparation, scope: PreparationScope): void {
    if (claim.callerRequestId !== `independent-call:${scope.operationId}` || plan.targetSessionId !== scope.sessionId || plan.task.labels?.roundId !== scope.roundId
        || plan.task.labels?.invocationId !== claim.invocation.invocationId || !validContext(context, scope)
        || Object.entries(targetLabels(scope.target)).some(([key, value]) => plan.task.labels?.[key] !== value))
        throw invalid('CALL_PREPARATION_SCOPE_MISMATCH');
}
function validContext(context: PreparedConversationContext, scope: PreparationScope): boolean {
    return !!context && validContextIdentity(context, scope) && validContextNumbers(context)
        && typeof context.profile?.id === 'string' && /^[a-f0-9]{64}$/.test(context.digest);
}
function validContextIdentity(context: PreparedConversationContext, scope: PreparationScope): boolean {
    return typeof context.id === 'string' && !!context.id && typeof context.taskRunId === 'string' && !!context.taskRunId
        && context.branchRef === scope.branch && context.branchHead === null
        && context.agent?.id === scope.target.id && context.agent.version === scope.target.version;
}
function validContextNumbers(context: PreparedConversationContext): boolean {
    return Number.isFinite(context.createdAt) && Number.isSafeInteger(context.profile?.revision) && context.profile.revision >= 0
        && Number.isFinite(context.tokenCount) && context.tokenCount >= 0;
}
export {invalid as independentPreparationError};
function invalid(code: string): Error {return Object.assign(new Error(code), {code});}

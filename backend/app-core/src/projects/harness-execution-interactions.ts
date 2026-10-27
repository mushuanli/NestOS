import { sha256HexSync } from '@itookit/common';
import type { EffectExecutionContext, JsonValue } from '@itookit/durable-kernel';
import type { HarnessEvent, HarnessEvents } from '@itookit/nestos-node-driver';
import type { HarnessInteractionNotification } from '@itookit/kernel-adapters/contracts';
import { executionError, jsonValue, nativeOperationId } from './harness-execution-journal';
import { nativeMutation, NATIVE_MUTATION_HELD, type NativeExecution } from './harness-execution-operations';
import { nativeInputResponse } from './harness-execution-input';

const responseDiagnostics = new WeakMap<NativeExecution['journal'], Map<string, string>>();

function interactionIdentity(request: HarnessEvent['message']): string {
    if (typeof request.id !== 'string' && typeof request.id !== 'number') throw executionError('NATIVE_INTERACTION_INVALID');
    return `${typeof request.id}:${request.id}`;
}
function notification(request: HarnessEvent['message'], id: string): HarnessInteractionNotification {
    const input = request.method === 'item/tool/requestUserInput';
    if (!input && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method))
        throw executionError('NATIVE_INTERACTION_UNSUPPORTED');
    const params = request.params ?? {};
    const prompt = ['reason', 'command', 'path', 'toolName'].flatMap(key => typeof params[key] === 'string' ? [params[key]] : []).join('\n');
    return { id, kind: input ? 'input' : 'approval', prompt: prompt || (input ? 'Native input requested' : 'Native approval requested'),
        payload: jsonValue({ ...params, method: request.method, nativeRequestId: request.id }) };
}
async function publishInteraction(run: NativeExecution, context: EffectExecutionContext, request: HarnessEvent['message'], id: string): Promise<void> {
    if (run.journal.data.notified.includes(id)) return;
    const state = context.sessionState!;
    const prior = await state.get(run.request.notificationKey);
    if ((prior?.value as { id?: string } | undefined)?.id !== id) {
        await state.set(run.request.notificationKey, jsonValue(notification(request, id)), prior?.version ?? null);
    }
    await run.journal.save({ notified: [...run.journal.data.notified, id] });
}
async function respond(run: NativeExecution, request: HarnessEvent['message'], step: string, response: JsonValue): Promise<boolean> {
    const answer = request.method === 'item/tool/requestUserInput' ? nativeInputResponse(request, response) : checkedApproval(request, response);
    const result = await nativeMutation(run, step, options => run.acquired.client.respond(run.acquired.profile.id,
        request.id!, answer, options), true);
    return result !== NATIVE_MUTATION_HELD;
}
function checkedApproval(request: HarnessEvent['message'], response: JsonValue): Record<string, JsonValue> {
    if (typeof response === 'boolean') return approvalResponse(request, { approved: response });
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw executionError('NATIVE_RESPONSE_INVALID');
    return approvalResponse(request, response);
}
function approvalResponse(request: HarnessEvent['message'], response: Record<string, JsonValue>): Record<string, JsonValue> {
    const offered = request.params?.decisions ?? request.params?.availableDecisions;
    if (!Array.isArray(offered) || !offered.every(value => typeof value === 'string')) throw executionError('NATIVE_DECISIONS_UNKNOWN');
    assertConsistentApproval(response);
    const choices = approvalChoices(response);
    const selected = choices.find(value => offered.includes(value));
    if (!selected) throw executionError('NATIVE_RESPONSE_INVALID');
    return { decision: selected };
}
function assertConsistentApproval(response: Record<string, JsonValue>): void {
    if (typeof response.approved !== 'boolean' || response.decision === undefined) return;
    const choices = response.approved ? ['accept', 'allow', 'approve'] : ['decline', 'deny', 'reject'];
    if (!choices.includes(String(response.decision))) throw executionError('NATIVE_RESPONSE_CONFLICT');
}
function approvalChoices(response: Record<string, JsonValue>): string[] {
    if (response.decision === undefined) {
        if (response.approved === true) return ['accept', 'allow'];
        return response.approved === false ? ['decline', 'deny'] : [];
    }
    const decision = String(response.decision);
    if (['accept', 'allow', 'approve'].includes(decision)) return [decision, 'accept', 'allow'];
    if (['decline', 'deny', 'reject'].includes(decision)) return [decision, 'decline', 'deny'];
    return [decision];
}
export async function driveNativeInteractions(run: NativeExecution, context: EffectExecutionContext, page: HarnessEvents): Promise<void> {
    for (const request of matchingRequests(run, page)) {
        const id = interactionIdentity(request), step = `respond-${sha256HexSync(id)}`;
        if (run.journal.data.operations[step]?.outcome === 'committed') continue;
        const response = await context.sessionState!.get(`${run.request.notificationKey}.response.${encodeURIComponent(id)}`);
        if (response) {
            const started = Date.now(), delivered = await respond(run, request, step, response.value);
            await diagnoseResponse(run, context, step, delivered ? 'committed' : 'held', started);
            if (!delivered) return;
            continue;
        }
        await publishInteraction(run, context, request, id);
        return;
    }
}
async function diagnoseResponse(run: NativeExecution, context: EffectExecutionContext, step: string, outcome: string, started: number): Promise<void> {
    const previous = responseDiagnostics.get(run.journal) ?? new Map<string, string>();
    if (previous.get(step) === outcome) return;
    previous.set(step, outcome); responseDiagnostics.set(run.journal, previous);
    try { await context.emit?.({ type: 'harness:execution', payload: { operation: 'harness.respond',
        operationId: nativeOperationId(context, step), stage: 'admission', outcome, durationMs: Date.now() - started,
        sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId } }); } catch { /* Diagnostics cannot change admission. */ }
}
function matchingRequests(run: NativeExecution, page: HarnessEvents): HarnessEvent['message'][] {
    return page.requests.filter(request => request.params?.threadId === run.journal.data.sessionId
        && (request.params?.turnId === undefined || request.params.turnId === run.journal.data.turnId));
}

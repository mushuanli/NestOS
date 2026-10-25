import {expect, it, vi} from 'vitest';
import type {EffectExecutionContext} from '@itookit/durable-kernel';
import type {LLMLogSink} from '@itookit/driver-llm/contracts';
import type {HarnessExecutionProvider, HarnessExecutionRequest} from '../llm-management/contracts/harness-execution';
import {HarnessExecutionEffect} from './harness-execution-effect';

const request: HarnessExecutionRequest = {connection: {id: 'connection', name: 'Connection', kind: 'harness',
    version: 1, revision: 1, nodeConnectionId: 'node', projectId: 'project', profileId: 'native', project: {}},
    prompt: 'Private input', resourceHandleId: 'grant', notificationKey: 'notification'};
const owner = {sessionId: 'session', taskId: 'task', effectId: 'effect'};
const context = {...owner, abortSignal: new AbortController().signal, sessionState: {},
    grants: [{handleId: 'grant', right: 'execute', resource: {kind: 'harness'}}]} as unknown as EffectExecutionContext;
const result = {text: 'Private result', sessionId: 'native-session', turnId: 'native-turn'};

function fixture() {
    const provider: HarnessExecutionProvider = {execute: vi.fn(async () => result),
        reconcile: vi.fn(async () => ({status: 'completed', result})),
        cancel: vi.fn(async () => ({status: 'stopped', cleanup: 'confirmed',
            evidence: {...owner, ref: 'persisted-journal', kind: 'terminal'}}))};
    const info = vi.fn(() => {throw new Error('Diagnostic sink unavailable');});
    return {provider, info, effect: new HarnessExecutionEffect(provider, {info} as unknown as LLMLogSink)};
}

it('preserves an executed native result when the diagnostic sink throws', async () => {
    const f = fixture();
    await expect(f.effect.execute(request, context)).resolves.toEqual(result);
    expect(f.provider.execute).toHaveBeenCalledOnce();
    expect(f.info).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.info.mock.calls)).not.toContain('Private');
});

it('preserves reconciliation and confirmed physical cleanup when the diagnostic sink throws', async () => {
    const f = fixture();
    await expect(f.effect.reconcile(request, context)).resolves.toEqual({status: 'completed', result});
    await expect(f.effect.cancel(request, context)).resolves.toBeUndefined();
    expect(f.provider.reconcile).toHaveBeenCalledOnce();
    expect(f.provider.cancel).toHaveBeenCalledOnce();
});

it('preserves the actual native failure instead of replacing it with a diagnostic error', async () => {
    const f = fixture(), failure = Object.assign(new Error('Native execution failed'), {code: 'NATIVE_TURN_FAILED'});
    vi.mocked(f.provider.execute).mockRejectedValue(failure);
    await expect(f.effect.execute(request, context)).rejects.toBe(failure);
    expect(f.effect.failureOutcome(failure)).toBe('failed');
});

it('keeps unconfirmed cleanup pending even when its diagnostic cannot be recorded', async () => {
    const f = fixture();
    vi.mocked(f.provider.cancel).mockResolvedValue({status: 'unknown', code: 'NATIVE_EPOCH_CHANGED'});
    await expect(f.effect.cancel(request, context)).rejects.toMatchObject({code: 'CONNECTION_STOP_UNKNOWN', nativeCode: 'NATIVE_EPOCH_CHANGED'});
});

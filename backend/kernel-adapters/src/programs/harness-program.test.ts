import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel, bindCapabilities, type EffectExecutionContext } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import type { HarnessConnectionSnapshot, HarnessExecutionProvider, HarnessExecutionRequest } from '../llm-management/contracts/harness-execution';
import { HarnessProgram } from './harness-program';
import { HarnessExecutionEffect } from '../effects/harness-execution-effect';

const connection: HarnessConnectionSnapshot = { id: 'remote', name: 'Remote', kind: 'harness', version: 1, revision: 1,
    nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: { id: 'project', revision: 1 } };
const closures: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closures.splice(0).reverse()) await close(); });

async function fixture(provider: HarnessExecutionProvider) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/sessions/one' }; } });
    kernel.registerProgram(new HarnessProgram()); kernel.registerEffect(new HarnessExecutionEffect(provider));
    await kernel.initialize(); const session = await kernel.createSession({ id: 'one', storage: { kind: 'test', locator: null } });
    closures.push(async () => { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); });
    const task = await session.spawn({ program: { kind: 'kernel-adapters.harness', version: '1' },
        input: { connection, messages: [{ role: 'user', content: 'Review this project' }] }, deferStart: true });
    await bindCapabilities(task, [{ kind: 'harness', uri: 'harness://test', rights: ['execute'], signalKey: 'harnessHandleId' }]);
    return { kernel, task, session };
}

function provider(execute: HarnessExecutionProvider['execute'], cancel = vi.fn(async () => {})): HarnessExecutionProvider {
    return { execute, cancel, reconcile: async (request, context) => ({ status: 'completed', result: await execute(request, context) }) };
}
async function notify(request: HarnessExecutionRequest, context: EffectExecutionContext) {
    await context.sessionState!.set(request.notificationKey, { id: 'native/approval:1', kind: 'approval', prompt: 'Allow workspace read?',
        payload: { decisions: ['allow', 'deny'] } });
}

describe('HarnessProgram durable interaction bridge', () => {
    it('runs without a model resource and persists a native response before completing', async () => {
        const execute = vi.fn(async (request: HarnessExecutionRequest, context: EffectExecutionContext) => {
            await notify(request, context);
            const key = `${request.notificationKey}.response.${encodeURIComponent('native/approval:1')}`;
            await vi.waitFor(async () => expect((await context.sessionState!.get(key))?.value).toEqual({ decision: 'allow' }));
            return { text: 'Remote review complete', sessionId: 'native-session', turnId: 'native-turn' };
        });
        const { task, session } = await fixture(provider(execute));
        const id = `harness:${encodeURIComponent('native/approval:1')}`;
        await vi.waitFor(async () => expect((await task.status()).task.interactions[id]?.status).toBe('pending'));
        expect((await session.readEvents()).items.some(event => event.type === 'effect.leased')).toBe(true);
        await task.respond({ interactionId: id, value: { decision: 'allow' } });
        const exit = await task.wait({ timeoutMs: 3000 });
        expect(exit.status).toBe('succeeded');
        expect(exit.output).toMatchObject({ message: { role: 'assistant', content: 'Remote review complete' },
            outputs: { result: { type: 'text', content: 'Remote review complete' } }, harness: { turnId: 'native-turn' } });
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][1].grants.map(grant => grant.resource.kind)).toEqual(['harness']);
    });

    it('keeps the native Effect cancellable while waiting for an Interaction', async () => {
        const cancel = vi.fn(async () => {});
        const execute = async (request: HarnessExecutionRequest, context: EffectExecutionContext) => {
            await notify(request, context);
            await new Promise<void>(resolve => context.abortSignal.addEventListener('abort', () => resolve(), { once: true }));
            context.abortSignal.throwIfAborted();
            return { text: '', sessionId: 'native-session', turnId: 'native-turn' };
        };
        const { task } = await fixture(provider(execute, cancel));
        await vi.waitFor(async () => expect(Object.values((await task.status()).task.interactions)).toHaveLength(1));
        await task.cancel('User cancelled remote execution');
        await task.waitStopped({ timeoutMs: 3000 });
        expect(cancel).toHaveBeenCalled();
        expect((await task.status()).task.status).toBe('cancelled');
    });
});

it('rejects image input rather than silently dropping it', () => {
    expect(() => new HarnessProgram().init({ connection, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }))
        .toThrow('HARNESS_TEXT_MESSAGES_REQUIRED');
});

it('requires a separately granted harness capability and propagates uncertain cancellation', async () => {
    const remote = provider(vi.fn()), adapter = new HarnessExecutionEffect(remote);
    const request = { connection, prompt: 'private prompt must not appear in diagnostics', resourceHandleId: 'h', notificationKey: 'notice' };
    const context = { sessionId: 's', taskId: 't', effectId: 'e', grants: [], abortSignal: new AbortController().signal };
    await expect(adapter.execute(request, context)).rejects.toThrow();
    expect(remote.execute).not.toHaveBeenCalled();
    vi.mocked(remote.cancel).mockRejectedValueOnce(new Error('HARNESS_STOP_UNCONFIRMED'));
    await expect(adapter.cancel(request, context)).rejects.toThrow('HARNESS_STOP_UNCONFIRMED');
});

it('reports reconciliation uncertainty and safe failure codes without prompt or remote error text', async () => {
    const remote = provider(vi.fn()), info = vi.fn(), adapter = new HarnessExecutionEffect(remote, { info } as never);
    const request = { connection, prompt: 'private prompt', resourceHandleId: 'h', notificationKey: 'notice' };
    const context: EffectExecutionContext = { sessionId: 's', taskId: 't', effectId: 'e',
        grants: [{ handleId: 'h', right: 'execute', resource: { id: 'r', sessionId: 's', kind: 'harness', uri: 'harness://test', generation: 1, createdAt: 1 } }],
        sessionState: { get: vi.fn(), set: vi.fn() }, abortSignal: new AbortController().signal };
    remote.reconcile = vi.fn(async () => ({ status: 'indeterminate', error: { code: 'NATIVE_EPOCH_CHANGED', message: 'private remote data' } }));
    expect((await adapter.reconcile(request, context)).status).toBe('indeterminate');
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ stage: 'reconcile', result: 'indeterminate', errorCategory: 'native-state-unknown' });
    vi.mocked(remote.execute).mockRejectedValue(Object.assign(new Error('private remote data'), { code: 'NATIVE_DISCONNECTED' }));
    await expect(adapter.execute(request, context)).rejects.toThrow();
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ stage: 'execute', result: 'indeterminate', errorCategory: 'NATIVE_DISCONNECTED' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private');
});

it('keeps a live unknown outcome pending and resumes the same Effect only after explicit resolution', async () => {
    const execute = vi.fn().mockRejectedValueOnce(Object.assign(new Error('lost native reply'), { code: 'NATIVE_OUTCOME_UNKNOWN' }))
        .mockResolvedValue({ text: 'Recovered original native result', sessionId: 'native-session', turnId: 'native-turn' });
    const { task } = await fixture(provider(execute));
    await vi.waitFor(async () => expect((await task.status()).task.effects.harness?.status).toBe('indeterminate'));
    expect((await task.status()).task.status).toBe('waiting');
    expect(execute).toHaveBeenCalledOnce();
    expect((await task.recoveryIssues()).some(issue => issue.reason === 'effect-indeterminate')).toBe(true);
    await task.resolveEffect({ requestId: 'reconcile-original-invocation', effectId: 'harness', outcome: { type: 'retry' } });
    const exit = await task.wait({ timeoutMs: 3000 });
    expect(exit.status).toBe('succeeded'); expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1].taskId).toBe(execute.mock.calls[1][1].taskId);
    expect(execute.mock.calls[0][1].effectId).toBe(execute.mock.calls[1][1].effectId);
});

it.each([
    { code: 'NATIVE_TURN_FAILED' }, { code: 'NATIVE_TURN_CANCELLED' },
    { code: 'CLAUDE_SESSION_LIMIT', executionOutcome: 'not-started' },
])('fails deterministically only with authoritative negative execution evidence: $code', async evidence => {
    const execute = vi.fn(async () => { throw Object.assign(new Error('Authoritative native outcome'), evidence); });
    const { task } = await fixture(provider(execute));
    expect(await task.wait({ timeoutMs: 3000 })).toMatchObject({ status: 'failed', error: { code: evidence.code } });
    expect((await task.status()).task.effects.harness.status).toBe('failed'); expect(execute).toHaveBeenCalledOnce();
});

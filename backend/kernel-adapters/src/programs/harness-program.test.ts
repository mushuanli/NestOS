import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel, bindCapabilities, type EffectExecutionContext } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import type { HarnessConnectionSnapshot, HarnessExecutionProvider, HarnessExecutionRequest } from '../llm-management/contracts/harness-execution';
import { HarnessProgram } from './harness-program';
import { HarnessExecutionEffect } from '../effects/harness-execution-effect';
import type {HarnessContextRequest} from '../llm-management/contracts/context-binding';
import type {ConnectionCancelResult} from '../llm-management/contracts/connection-control';

const connection: HarnessConnectionSnapshot = { id: 'remote', name: 'Remote', kind: 'harness', version: 1, revision: 1,
    nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: { id: 'project', revision: 1 } };
const closures: Array<() => Promise<void>> = [];
const context: HarnessContextRequest = {invocationId: 'call', branchId: 'main', targetRef: 'agent@1', scopeRef: 'conversation', policyRef: 'policy',
    workspaceRef: 'workspace', memoryPolicyRef: 'native-inherited', conversation: {mode: 'new'},
    input: {mode: 'host-assembled', snapshotRef: 'snapshot', digest: 'digest'}};
afterEach(async () => { for (const close of closures.splice(0).reverse()) await close(); });

it('rejects an assembly reference with no persisted matching snapshot basis', () => {
    const program = new HarnessProgram(), input = {connection, context, messages: [{role: 'user', content: 'Review'}]};
    expect(() => program.init(input)).toThrow('HARNESS_CONTEXT_SNAPSHOT_REQUIRED');
    expect(() => program.init({...input, contextSnapshot: {id: 'snapshot', digest: 'another-digest'} as never}))
        .toThrow('HARNESS_CONTEXT_SNAPSHOT_REQUIRED');
});

it('rejects full local history in native continuation instead of injecting it as another user prompt', () => {
    const continuation: HarnessContextRequest = {...context, input: {mode: 'native-continuation', inputRef: 'increment', digest: 'digest'},
        conversation: {mode: 'continue', bindingId: 'binding', expectedBindingRevision: 1, expectedGeneration: 1}};
    expect(() => new HarnessProgram().init({connection, context: continuation, messages: [{role: 'user', content: 'Entire local history'}]}))
        .toThrow('HARNESS_INCREMENTAL_INPUT_REQUIRED');
});

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

function provider(execute: HarnessExecutionProvider['execute'], cancel: HarnessExecutionProvider['cancel'] = vi.fn(async (_request, ctx) => confirmedStop(ctx))): HarnessExecutionProvider {
    return { execute, cancel, reconcile: async (request, context) => ({ status: 'completed', result: await execute(request, context) }) };
}

it.each([
    [{status: 'unknown', code: 'NATIVE_RESULT_PENDING'}, 'CONNECTION_STOP_UNKNOWN'],
    [{status: 'pending', phase: 'execution'}, 'CONNECTION_STOP_PENDING'],
    [{status: 'pending', phase: 'cleanup'}, 'CONNECTION_CLEANUP_PENDING'],
    [{status: 'stopped', cleanup: 'pending'}, 'CONNECTION_CLEANUP_PENDING'],
    [undefined, 'CONNECTION_CANCEL_RESULT_INVALID'],
    [false, 'CONNECTION_CANCEL_RESULT_INVALID'],
    [1, 'CONNECTION_CANCEL_RESULT_INVALID'],
    ['legacy-success', 'CONNECTION_CANCEL_RESULT_INVALID'],
    [[], 'CONNECTION_CANCEL_RESULT_INVALID'],
    [{status: 'stopped'}, 'CONNECTION_CANCEL_RESULT_INVALID'],
] as const)('refuses to confirm Effect cleanup for %j', async (result, code) => {
    const remote = provider(vi.fn(), vi.fn(async () => result as ConnectionCancelResult));
    const info = vi.fn(), adapter = new HarnessExecutionEffect(remote, {info} as never);
    const request = {connection, prompt: 'private prompt', resourceHandleId: 'h', notificationKey: 'notice'};
    const ctx = {sessionId: 's', taskId: 't', effectId: 'e', grants: [], abortSignal: AbortSignal.abort()};
    await expect(adapter.cancel(request, ctx)).rejects.toMatchObject({code});
    expect(info).toHaveBeenCalledWith('Harness execution', expect.objectContaining({operation: 'harness.cancel', result: 'unconfirmed', errorCategory: code}));
    expect(JSON.stringify(info.mock.calls)).not.toContain('private prompt');
});

it.each<ConnectionCancelResult>([{status: 'unknown'}, {status: 'pending', phase: 'cleanup'}])(
    'keeps Kernel cleanup pending across an unconfirmed connection result %j', async initial => {
        let result = initial;
        const execute = vi.fn(async (_request, ctx: EffectExecutionContext) => {
            await new Promise<void>(resolve => ctx.abortSignal.addEventListener('abort', () => resolve(), {once: true}));
            ctx.abortSignal.throwIfAborted();
            return {text: '', sessionId: 'native', turnId: 'turn'};
        });
        const cancel = vi.fn(async () => result), {task, session} = await fixture(provider(execute, cancel));
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        await expect(task.cancel('Stop')).rejects.toThrow();
        expect((await task.status()).task).toMatchObject({status: 'cancelled', effects: {harness: {cleanupPending: true}}});
        expect(await task.stat()).toMatchObject({settled: false, stopped: false, control: {acknowledged: false}});
        result = confirmedStop(execute.mock.calls[0][1]);
        await session.recover();
        await task.waitStopped({timeoutMs: 3000});
        expect((await task.status()).task.effects.harness.cleanupPending).toBe(false);
        expect(execute).toHaveBeenCalledOnce();
    });

it.each(['sessionId', 'taskId', 'effectId', 'ref', 'kind'] as const)('rejects stopped evidence with mismatched %s', async field => {
    const ctx = {sessionId: 's', taskId: 't', effectId: 'e', grants: [], abortSignal: AbortSignal.abort()};
    const result = confirmedStop(ctx) as Extract<ConnectionCancelResult, {status: 'stopped'}>;
    Object.assign(result.evidence, {[field]: field === 'ref' ? '' : 'different'});
    const remote = provider(vi.fn(), vi.fn(async () => result)), adapter = new HarnessExecutionEffect(remote);
    await expect(adapter.cancel({connection, prompt: 'Private', resourceHandleId: 'h', notificationKey: 'notice'}, ctx))
        .rejects.toMatchObject({code: 'CONNECTION_STOP_EVIDENCE_INVALID'});
});

it('retains the local in-flight barrier after native stopping and cleanup have been confirmed', async () => {
    let finish!: (value: {text: string; sessionId: string; turnId: string}) => void;
    const execute = vi.fn(() => new Promise<{text: string; sessionId: string; turnId: string}>(resolve => {finish = resolve;}));
    const cancel = vi.fn(async (_request, ctx) => confirmedStop(ctx));
    const {task} = await fixture(provider(execute, cancel));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let confirmed = false;
    const cancellation = task.cancel('Stop').then(() => {confirmed = true;});
    try {
        await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
        expect(confirmed).toBe(false);
        expect((await task.status()).task.effects.harness.cleanupPending).toBe(true);
    } finally {finish({text: 'Late completion', sessionId: 'native', turnId: 'turn'}); await cancellation;}
    expect(await task.waitStopped({timeoutMs: 3000})).toMatchObject({settled: true, stopped: true});
    expect((await task.status()).task.status).toBe('cancelled');
});
function confirmedStop(ctx: EffectExecutionContext): ConnectionCancelResult {
    return {status: 'stopped', cleanup: 'confirmed', evidence: {sessionId: ctx.sessionId, taskId: ctx.taskId, effectId: ctx.effectId, kind: 'terminal', ref: 'test-journal'}};
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
        const cancel: HarnessExecutionProvider['cancel'] = vi.fn(async (_request, ctx) => confirmedStop(ctx));
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

it('keeps image input in the effect request and refuses remote URLs instead of dropping them', () => {
    const program = new HarnessProgram(), url = 'data:image/png;base64,iVBORw0KGgo=';
    const initial = program.init({connection, messages: [{role: 'user', content: [{type: 'image_url', image_url: {url}}]}]});
    const next = program.reduce(initial.state, {type: 'signal', signal: {type: 'capabilities', payload: {harnessHandleId: 'handle'}}});
    expect(next.actions).toMatchObject([{type: 'effect', effect: {request: {attachments: [{kind: 'image', content: url, mimeType: 'image/png'}]}}}]);
    expect(() => program.init({connection, messages: [{role: 'user', content: [{type: 'image_url', image_url: {url: 'https://private.invalid/image'}}]}]}))
        .toThrow('HARNESS_ATTACHMENT_INLINE_REQUIRED');
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
    remote.reconcile = vi.fn(async () => ({status: 'unknown', code: 'NATIVE_EPOCH_CHANGED'}));
    expect((await adapter.reconcile(request, context)).status).toBe('indeterminate');
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ stage: 'reconcile', result: 'indeterminate', errorCategory: 'NATIVE_EPOCH_CHANGED' });
    vi.mocked(remote.execute).mockRejectedValue(Object.assign(new Error('private remote data'), { code: 'NATIVE_DISCONNECTED' }));
    await expect(adapter.execute(request, context)).rejects.toThrow();
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ stage: 'execute', result: 'indeterminate', errorCategory: 'NATIVE_DISCONNECTED' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private');
});

function recoveryContext(): EffectExecutionContext {
    return {sessionId: 's', taskId: 't', effectId: 'e', abortSignal: new AbortController().signal,
        grants: [{handleId: 'h', right: 'execute', resource: {id: 'r', sessionId: 's', kind: 'harness', uri: 'harness://test', generation: 1, createdAt: 1}}],
        sessionState: {get: vi.fn(), set: vi.fn()}};
}

it.each([
    [{status: 'running', handleRef: 'original-handle'}, 'CONNECTION_STILL_RUNNING'],
    [{status: 'unknown', code: 'NATIVE_EPOCH_CHANGED'}, 'NATIVE_EPOCH_CHANGED'],
    [{status: 'unknown', code: 'private remote data'}, 'CONNECTION_STATE_UNKNOWN'],
    [{status: 'retry'}, 'CONNECTION_RECONCILE_RESULT_INVALID'],
] as const)('never converts an unresolved connection result into execution retry: %j', async (result, code) => {
    const remote = provider(vi.fn()), info = vi.fn(), adapter = new HarnessExecutionEffect(remote, {info} as never), ctx = recoveryContext();
    remote.reconcile = vi.fn(async () => result as never);
    const value = await adapter.reconcile({connection, prompt: 'Private input', resourceHandleId: 'h', notificationKey: 'notice'}, ctx);
    expect(value).toMatchObject({status: 'indeterminate', error: {code}});
    expect(JSON.stringify(value)).not.toContain('private remote data');
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({stage: 'reconcile', result: 'indeterminate', errorCategory: code});
    expect(remote.execute).not.toHaveBeenCalled(); expect(remote.reconcile).toHaveBeenCalledOnce();
});

it('allows retry only from not-started evidence for this exact fenced execution', async () => {
    const remote = provider(vi.fn()), adapter = new HarnessExecutionEffect(remote), ctx = recoveryContext();
    const evidence = {...(confirmedStop(ctx) as Extract<ConnectionCancelResult, {status: 'stopped'}>).evidence, kind: 'not-started' as const};
    const request = {connection, prompt: 'Private input', resourceHandleId: 'h', notificationKey: 'notice'};
    remote.reconcile = vi.fn(async () => ({status: 'not-started', evidence}));
    expect(await adapter.reconcile(request, ctx)).toEqual({status: 'retry'});
    for (const invalid of [{...evidence, taskId: 'another'}, {...evidence, kind: 'terminal'}, undefined]) {
        vi.mocked(remote.reconcile).mockResolvedValueOnce({status: 'not-started', evidence: invalid} as never);
        await expect(adapter.reconcile(request, ctx)).rejects.toMatchObject({code: 'CONNECTION_NOT_STARTED_EVIDENCE_INVALID', effectOutcome: 'indeterminate'});
    }
    expect(remote.execute).not.toHaveBeenCalled();
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

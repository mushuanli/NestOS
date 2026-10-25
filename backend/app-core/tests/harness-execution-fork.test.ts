import {expect, it, vi} from 'vitest';
import type {HarnessExecutionRequest} from '@itookit/kernel-adapters/contracts';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {harnessExecutionJournalKey} from '../src/projects/harness-execution';
import {context, operation} from './harness-context-fixture';
import {complete, fixture, request} from './harness-execution-fixture';

async function forkFixture() {
    const f = fixture(), store = new HarnessContextBindings(f.state, f.context.sessionId);
    await store.claim('source', context, request.connection, operation);
    await store.attach('source', operation.operationId, {nodeConnectionId: 'node', profileId: 'claude', workspaceId: 'workspace',
        sessionId: 'parent-native', epoch: 'service-epoch'});
    const staged = await store.prepareSettlement('source', operation.operationId, {operationId: operation.operationId, kind: 'terminal', knownHeadRef: 'parent-turn'});
    const source = await store.release('source', operation.operationId, staged.revision + 1);
    f.profile.capabilities.fork = true; f.profile.capabilities.checkpointFork = true;
    const result = {session: f.session, checkpoint: {sourceSessionId: 'parent-native', turnId: 'parent-turn', verified: true}};
    f.client.fork = vi.fn(async (_profile, _source, _name, options) => f.committed(options, result) as typeof result);
    const call: HarnessExecutionRequest = {...request, prompt: 'Increment only', context: {...context, invocationId: 'child-call',
        branchId: 'child-branch', scopeRef: 'worker-instance', input: {mode: 'native-continuation', inputRef: 'increment', digest: 'digest'},
        conversation: {mode: 'fork', sourceBindingId: 'source', expectedBindingRevision: source.revision,
            expectedGeneration: source.generation, checkpointRef: 'parent-turn'}}};
    return {...f, store, source, call, result};
}

it('forks a confirmed binding checkpoint, sends only the increment and preserves the source binding', async () => {
    const f = await forkFixture(); complete(f); const result = await f.make().execute(f.call, f.context);
    expect(f.client.fork).toHaveBeenCalledWith('claude', 'parent-native', undefined, expect.objectContaining({lastTurnId: 'parent-turn'}));
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).toHaveBeenCalledWith('claude', 'native-session', 'Increment only', expect.anything());
    const binding = await f.store.get(result.contextBinding!.bindingId);
    expect(binding).toMatchObject({branchId: 'child-branch', scopeRef: 'worker-instance', forkedFrom: {bindingId: 'source', checkpointRef: 'parent-turn'}});
    expect(binding?.activeOperation).toBeUndefined(); expect(await f.store.get('source')).toEqual(f.source);
});

it('sends the selected earlier checkpoint to the native fork after the source binding has advanced', async () => {
    const f = await forkFixture(), next = {...operation, operationId: 'later', invocationId: 'later-call', fingerprint: 'later-input'};
    await f.store.claim('source', {...context, invocationId: next.invocationId, input: {mode: 'native-continuation', inputRef: 'later', digest: 'later'},
        conversation: {mode: 'continue', bindingId: 'source', expectedBindingRevision: f.source.revision, expectedGeneration: 1}}, request.connection, next);
    const staged = await f.store.prepareSettlement('source', next.operationId, {operationId: next.operationId, kind: 'terminal', knownHeadRef: 'later-turn'});
    const latest = await f.store.release('source', next.operationId, staged.revision + 1);
    if (f.call.context!.conversation.mode === 'fork') f.call.context!.conversation.expectedBindingRevision = latest.revision;
    complete(f); await f.make().execute(f.call, f.context);
    expect(f.client.fork).toHaveBeenCalledWith('claude', 'parent-native', undefined, expect.objectContaining({lastTurnId: 'parent-turn'}));
    expect((await f.store.get('source'))?.knownHeadRef).toBe('later-turn');
    expect(f.client.turn).toHaveBeenCalledOnce();
});

it('queries a lost fork receipt rather than cloning again after restart', async () => {
    const f = await forkFixture(); vi.mocked(f.client.fork!).mockImplementationOnce(async (_p, _s, _n, options) => {
        f.committed(options, f.result); throw new Error('Fork reply lost');
    });
    await expect(f.make().execute(f.call, f.context)).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
    expect(f.client.turn).not.toHaveBeenCalled(); complete(f);
    expect(await f.make().reconcile(f.call, f.context)).toMatchObject({status: 'completed'});
    expect(f.client.fork).toHaveBeenCalledOnce(); expect(f.client.turn).toHaveBeenCalledOnce();
});

it('rejects journal source substitution before replaying a pending fork', async () => {
    const f = await forkFixture(); vi.mocked(f.client.fork!).mockImplementationOnce(async (_p, _s, _n, options) => {
        f.committed(options, f.result); throw new Error('Fork reply lost');
    });
    await expect(f.make().execute(f.call, f.context)).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
    const entry = f.records.get(harnessExecutionJournalKey(f.context))!, changed = structuredClone(entry.value) as any;
    changed.forkSource.nativeRef.sessionId = 'substituted-native-session'; f.records.set(entry.key, {...entry, value: changed});
    expect(await f.make().reconcile(f.call, f.context)).toMatchObject({status: 'unknown', code: 'JOURNAL_CONFLICT'});
    expect(f.client.fork).toHaveBeenCalledOnce(); expect(f.client.turn).not.toHaveBeenCalled();
});

it('retains a created but unverified branch without starting a turn or retrying that fork', async () => {
    const f = await forkFixture(); f.result.checkpoint.verified = false;
    await expect(f.make().execute(f.call, f.context)).rejects.toMatchObject({code: 'CONTEXT_CHECKPOINT_UNCONFIRMED', executionOutcome: 'not-started'});
    const binding = (await f.store.list()).find(value => value.id !== 'source')!;
    expect(binding).toMatchObject({validity: 'invalid', nativeRef: {sessionId: 'native-session'}});
    expect(binding.activeOperation).toBeUndefined(); expect(f.client.turn).not.toHaveBeenCalled();
    await expect(f.make().reconcile(f.call, f.context)).rejects.toMatchObject({code: 'CONTEXT_CHECKPOINT_UNCONFIRMED'});
    expect(f.client.fork).toHaveBeenCalledOnce(); expect(await f.store.get('source')).toEqual(f.source);
    f.connections.acquire.mockRejectedValueOnce(new Error('Grant withdrawn'));
    await f.make().cancel(f.call, f.context);
    expect(f.connections.acquire).toHaveBeenCalledOnce();
});

it('rejects stale or unsupported fork requests before any native mutation', async () => {
    const f = await forkFixture(); f.profile.capabilities.checkpointFork = false;
    await expect(f.make().execute(f.call, f.context)).rejects.toMatchObject({code: 'CONTEXT_CHECKPOINT_FORK_UNSUPPORTED', executionOutcome: 'not-started'});
    expect(f.client.fork).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    f.connections.acquire.mockRejectedValueOnce(new Error('Grant withdrawn'));
    await f.make().cancel(f.call, f.context); expect(f.connections.acquire).toHaveBeenCalledOnce();
    const g = await forkFixture(); if (g.call.context!.conversation.mode === 'fork') g.call.context!.conversation.expectedBindingRevision--;
    await expect(g.make().execute(g.call, g.context)).rejects.toMatchObject({code: 'CONTEXT_BINDING_CHANGED', executionOutcome: 'not-started'});
    expect(g.client.fork).not.toHaveBeenCalled();
});

it('recovers only the created fork during cancellation and never sends the unsent increment', async () => {
    const f = await forkFixture(); vi.mocked(f.client.fork!).mockRejectedValueOnce(new Error('Reply lost'));
    vi.mocked(f.client.operation).mockResolvedValue({requestId: '', outcome: 'unknown'});
    await expect(f.make().execute(f.call, f.context)).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
    const journal = f.records.get(harnessExecutionJournalKey(f.context))!.value as any;
    vi.mocked(f.client.operation).mockResolvedValue({requestId: journal.operations.fork.requestId, outcome: 'committed', result: f.result});
    f.controller.abort(); await f.make().cancel(f.call, f.context);
    expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.interrupt).not.toHaveBeenCalled(); expect(f.client.fork).toHaveBeenCalledOnce();
    expect((await f.store.get(journal.bindingId))?.activeOperation).toBeUndefined();
});

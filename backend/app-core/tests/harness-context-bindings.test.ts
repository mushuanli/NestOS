import {expect, it, vi} from 'vitest';
import type {HarnessContextRequest, NativeContextRef} from '@itookit/kernel-adapters/contracts';
import {CONTEXT_BINDINGS_KEY, HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {durableState, request} from './harness-execution-fixture';
import {context, operation} from './harness-context-fixture';

const native: NativeContextRef = {nodeConnectionId: 'node', profileId: 'claude', workspaceId: 'workspace', sessionId: 'thread', epoch: 'e'};
function fixture() {const storage = durableState(); return {...storage, store: new HarnessContextBindings(storage.state, 's')};}
async function completed(f: ReturnType<typeof fixture>) {
    await f.store.claim('binding', context, request.connection, operation); await f.store.attach('binding', operation.operationId, native);
    const prepared = await f.store.prepareSettlement('binding', operation.operationId, {operationId: operation.operationId, kind: 'terminal', knownHeadRef: 'head-1'});
    return f.store.release('binding', operation.operationId, prepared.revision + 1);
}
function continuation(revision: number, patch: Partial<HarnessContextRequest> = {}): HarnessContextRequest {
    return {...context, invocationId: 'call-2', input: {mode: 'native-continuation', inputRef: 'increment-2', digest: 'digest-2'},
        conversation: {mode: 'continue', bindingId: 'binding', expectedBindingRevision: revision, expectedGeneration: 1}, ...patch};
}
const nextOperation = {...operation, operationId: 'op-2', invocationId: 'call-2', fingerprint: 'input-2'};

it('retains confirmed earlier heads and forks one without following the latest native head', async () => {
    const f = fixture(), first = await completed(f);
    await f.store.claim('binding', continuation(first.revision), request.connection, nextOperation);
    const staged = await f.store.prepareSettlement('binding', nextOperation.operationId,
        {operationId: nextOperation.operationId, kind: 'terminal', knownHeadRef: 'head-2'});
    const latest = await f.store.release('binding', nextOperation.operationId, staged.revision + 1);
    expect(latest.checkpoints?.map(checkpoint => checkpoint.ref)).toEqual(['head-1', 'head-2']);
    expect(latest.checkpoints?.[1]).toMatchObject({previousRef: 'head-1', operation: nextOperation});
    const fork = {...continuation(latest.revision), conversation: {mode: 'fork' as const, sourceBindingId: latest.id,
        expectedBindingRevision: latest.revision, expectedGeneration: latest.generation, checkpointRef: 'head-1'}};
    const child = await f.store.claim('fork', fork, request.connection, nextOperation);
    expect(child.forkedFrom?.checkpointRef).toBe('head-1');
    expect((await f.store.get('binding'))?.knownHeadRef).toBe('head-2');
    await expect(f.store.claim('invented', {...fork, conversation: {...fork.conversation, checkpointRef: 'unseen'}}, request.connection, nextOperation))
        .rejects.toMatchObject({code: 'CONTEXT_CHECKPOINT_CHANGED'});
});

it('does not publish a checkpoint before release and reconciles a lost release acknowledgement without duplicating it', async () => {
    const f = fixture(); await f.store.claim('binding', context, request.connection, operation); await f.store.attach('binding', operation.operationId, native);
    const staged = await f.store.prepareSettlement('binding', operation.operationId, {operationId: operation.operationId, kind: 'terminal', knownHeadRef: 'head'});
    expect((await f.store.get('binding'))?.checkpoints).toBeUndefined();
    const set = f.state.set.bind(f.state);
    vi.spyOn(f.state, 'set').mockImplementationOnce(async (...args) => {await set(...args); throw new Error('Lost acknowledgement');});
    await expect(f.store.release('binding', operation.operationId, staged.revision + 1)).rejects.toMatchObject({code: 'CONTEXT_STORAGE_WRITE_FAILED'});
    const recovered = await f.store.release('binding', operation.operationId, staged.revision + 1);
    expect(recovered.checkpoints).toHaveLength(1); expect(recovered.checkpoints?.[0].operation).toEqual(operation);
});

it('keeps legacy latest heads readable without guessing their producing Invocation from the last operation', async () => {
    const f = fixture(), first = await completed(f), entry = f.records.get(CONTEXT_BINDINGS_KEY)!;
    delete (entry.value as any).bindings.binding.checkpoints;
    (entry.value as any).bindings.binding.lastOperation = {...operation, invocationId: 'rejected-later-call', operationId: 'rejected-later-operation'};
    await f.store.claim('binding', continuation(first.revision), request.connection, nextOperation);
    const staged = await f.store.prepareSettlement('binding', nextOperation.operationId, {operationId: nextOperation.operationId, kind: 'terminal', knownHeadRef: 'head-2'});
    const latest = await f.store.release('binding', nextOperation.operationId, staged.revision + 1);
    expect(latest.checkpoints?.map(checkpoint => checkpoint.ref)).toEqual(['head-1', 'head-2']);
    expect(latest.checkpoints?.[0]).toEqual({kind: 'legacy-head', ref: 'head-1'});
    expect(latest.checkpoints?.[1].operation).toEqual(nextOperation);
});

it('keeps a confirmed checkpoint after a later operation is definitely rejected', async () => {
    const f = fixture(), first = await completed(f);
    await f.store.claim('binding', continuation(first.revision), request.connection, nextOperation);
    const staged = await f.store.prepareSettlement('binding', nextOperation.operationId, {operationId: nextOperation.operationId, kind: 'not-started'});
    const settled = await f.store.release('binding', nextOperation.operationId, staged.revision + 1);
    expect(settled.knownHeadRef).toBe('head-1'); expect(settled.checkpoints).toEqual(first.checkpoints);
    expect(settled.lastOperation).toEqual(nextOperation);
});

it.each(['duplicate', 'foreign-parent', 'rewound-head'])('rejects a corrupt %s checkpoint history rather than publishing it', async kind => {
    const f = fixture(); await completed(f);
    const binding = (f.records.get(CONTEXT_BINDINGS_KEY)!.value as any).bindings.binding;
    if (kind === 'duplicate') binding.checkpoints.push(structuredClone(binding.checkpoints[0]));
    if (kind === 'foreign-parent') binding.checkpoints[0].previousRef = 'unseen';
    if (kind === 'rewound-head') binding.knownHeadRef = 'unseen';
    await expect(f.store.list()).rejects.toMatchObject({code: 'CONTEXT_STORAGE_INVALID'});
});

it('keeps independent bindings on one Connection and rejects aliases of the same native thread', async () => {
    const f = fixture(); await f.store.claim('binding', context, request.connection, operation);
    await f.store.claim('independent', context, request.connection, operation);
    await f.store.attach('binding', 'op-1', native);
    await expect(f.store.attach('independent', 'op-1', {...native, nodeConnectionId: 'another-node-alias', workspaceId: 'another-workspace'}))
        .rejects.toMatchObject({code: 'CONTEXT_NATIVE_ALIAS_CONFLICT'});
    await f.store.attach('independent', 'op-1', {...native, sessionId: 'different-thread'});
    const records = await f.store.list(); expect(records).toHaveLength(2);
    records[0].scopeRef = 'caller edit'; expect((await f.store.list())[0].scopeRef).toBe('conversation');
});

it('preserves both independent updates through Session CAS conflicts', async () => {
    const f = fixture(); await Promise.all(['first', 'second'].map(id => f.store.claim(id, context, request.connection, operation)));
    expect((await f.store.list()).map(binding => binding.id).sort()).toEqual(['first', 'second']);
});

it('serializes writers to one binding while keeping business Invocation identity independent', async () => {
    const f = fixture(), binding = await completed(f);
    const results = await Promise.allSettled([f.store.claim('binding', continuation(binding.revision), request.connection, nextOperation),
        f.store.claim('binding', continuation(binding.revision, {invocationId: 'call-3'}), request.connection,
            {...nextOperation, operationId: 'op-3', invocationId: 'call-3', fingerprint: 'input-3'})]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const current = await f.store.get('binding'); expect(current?.id).toBe('binding'); expect(current?.generation).toBe(1);
    expect(['call-2', 'call-3']).toContain(current?.activeOperation?.invocationId);
});

it.each(['branchId', 'targetRef', 'scopeRef', 'policyRef', 'workspaceRef', 'memoryPolicyRef'] as const)(
    'rejects incompatible %s without changing the binding', async field => {
        const f = fixture(), binding = await completed(f), before = f.records.get(CONTEXT_BINDINGS_KEY);
        await expect(f.store.claim('binding', continuation(binding.revision, {[field]: 'changed'}), request.connection, nextOperation))
            .rejects.toMatchObject({code: 'CONTEXT_POLICY_CHANGED'});
        expect(f.records.get(CONTEXT_BINDINGS_KEY)).toEqual(before);
    });

it('rejects stale revisions, generations, connection grants and full-history continuation', async () => {
    const f = fixture(), binding = await completed(f);
    await expect(f.store.claim('binding', continuation(binding.revision - 1), request.connection, nextOperation))
        .rejects.toMatchObject({code: 'CONTEXT_BINDING_CHANGED'});
    const changed = continuation(binding.revision); if (changed.conversation.mode === 'continue') changed.conversation.expectedGeneration++;
    await expect(f.store.claim('binding', changed, request.connection, nextOperation)).rejects.toMatchObject({code: 'CONTEXT_BINDING_CHANGED'});
    await expect(f.store.claim('binding', continuation(binding.revision), {...request.connection, revision: 2}, nextOperation))
        .rejects.toMatchObject({code: 'CONTEXT_POLICY_CHANGED'});
    await expect(f.store.claim('binding', continuation(binding.revision, {input: context.input}), request.connection, nextOperation))
        .rejects.toMatchObject({code: 'CONTEXT_INPUT_MODE_INVALID'});
});

it('requires an exact staged settlement and keeps ownership until its journal can be persisted', async () => {
    const f = fixture(); await f.store.claim('binding', context, request.connection, operation); await f.store.attach('binding', 'op-1', native);
    const staged = await f.store.prepareSettlement('binding', 'op-1', {operationId: 'op-1', kind: 'terminal', knownHeadRef: 'head'});
    expect((await f.store.get('binding'))?.activeOperation).toEqual(operation);
    await expect(f.store.release('binding', 'op-1', staged.revision + 2)).rejects.toMatchObject({code: 'CONTEXT_SETTLEMENT_CONFLICT'});
    await f.store.release('binding', 'op-1', staged.revision + 1);
    expect((await f.store.get('binding'))?.activeOperation).toBeUndefined();
});

it('rejects corrupt or foreign Session metadata and never retries unrelated storage failures', async () => {
    const f = fixture(); await f.state.set(CONTEXT_BINDINGS_KEY, {version: 1, sessionId: 'foreign', bindings: {}});
    await expect(f.store.list()).rejects.toMatchObject({code: 'CONTEXT_STORAGE_INVALID'});
    const g = fixture(), save = vi.spyOn(g.state, 'set').mockRejectedValue(new Error('Storage unavailable'));
    await expect(g.store.claim('binding', context, request.connection, operation)).rejects.toMatchObject({code: 'CONTEXT_STORAGE_WRITE_FAILED'});
    expect(save).toHaveBeenCalledOnce();
});

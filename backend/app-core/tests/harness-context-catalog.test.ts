import {expect, it, vi} from 'vitest';
import {createContextBindingReader} from '../src/projects/harness-context-catalog';
import {HarnessContextBindings, CONTEXT_BINDINGS_KEY} from '../src/projects/harness-context-bindings';
import {durableState, request} from './harness-execution-fixture';
import {context, operation} from './harness-context-fixture';

function fixture() {
    const f = durableState(), getShared = vi.fn(async (_id: string, key: string) => f.state.get(key));
    const inspectSession = vi.fn(async (id: string) => ({getShared: <T extends import('@itookit/durable-kernel').JsonValue>(key: string) => getShared(id, key) as ReturnType<typeof f.state.get<T>>}));
    const reader = createContextBindingReader({inspectSession});
    return {...f, getShared, inspectSession, reader, store: new HarnessContextBindings(f.state, 's')};
}
async function create(f: ReturnType<typeof fixture>, id: string, branchId = 'main') {
    await f.store.claim(id, {...context, branchId}, request.connection, operation);
    await f.store.attach(id, operation.operationId, {nodeConnectionId: 'private-node', profileId: 'profile', workspaceId: 'workspace',
        epoch: 'private-epoch', sessionId: `private-thread-${id}`});
    const staged = await f.store.prepareSettlement(id, operation.operationId, {operationId: operation.operationId, kind: 'terminal', knownHeadRef: `head-${id}`});
    return f.store.release(id, operation.operationId, staged.revision + 1);
}

async function advance(f: ReturnType<typeof fixture>, head: string) {
    const binding = (await f.store.get('a'))!, next = {...operation, operationId: head, invocationId: `call-${head}`, fingerprint: head};
    await f.store.claim('a', {...context, invocationId: next.invocationId, input: {mode: 'native-continuation', inputRef: head, digest: head},
        conversation: {mode: 'continue', bindingId: 'a', expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}}, request.connection, next);
    const staged = await f.store.prepareSettlement('a', next.operationId, {operationId: next.operationId, kind: 'terminal', knownHeadRef: head});
    await f.store.release('a', next.operationId, staged.revision + 1);
}

it('pages confirmed checkpoints in causal order and keeps a legacy observed head explicitly unattributed', async () => {
    const f = fixture(); await create(f, 'a');
    delete (f.records.get(CONTEXT_BINDINGS_KEY)!.value as any).bindings.a.checkpoints;
    const legacy = await f.reader({sessionId: 's', bindingId: 'a'});
    expect(legacy.checkpoints).toEqual([{kind: 'legacy-head', ref: 'head-a'}]);
    await advance(f, 'head-2'); await advance(f, 'head-3');
    const query = {sessionId: 's', bindingId: 'a', limit: 1}, first = await f.reader(query);
    const second = await f.reader({...query, cursor: first.nextCursor});
    const third = await f.reader({...query, cursor: second.nextCursor});
    expect(first.checkpoints?.[0]).toEqual({kind: 'legacy-head', ref: 'head-a'});
    expect(second.checkpoints?.[0]).toEqual({kind: 'terminal', ref: 'head-2', previousRef: 'head-a', invocationId: 'call-head-2'});
    expect(third.checkpoints?.[0].ref).toBe('head-3'); expect(third.nextCursor).toBeUndefined();
    expect(third.bindings[0].knownHeadRef).toBe('head-3');
});

it('projects one bounded read without exposing native identities, operation fingerprints or write authority', async () => {
    const f = fixture(); await create(f, 'b'); await create(f, 'a'); const writes = [...f.writes];
    const first = await f.reader({sessionId: 's', limit: 1});
    expect(first.bindings.map(binding => binding.ref.bindingId)).toEqual(['a']); expect(first.nextCursor).toBeDefined();
    expect((await f.reader({sessionId: 's', limit: 1, cursor: first.nextCursor})).bindings[0].ref.bindingId).toBe('b');
    const checkpoints = await f.reader({sessionId: 's', bindingId: 'a'});
    expect(checkpoints.checkpoints).toEqual([{kind: 'terminal', ref: 'head-a', invocationId: operation.invocationId}]);
    const serialized = JSON.stringify([first, checkpoints]);
    for (const hidden of ['private-node', 'private-epoch', 'private-thread', operation.fingerprint, operation.executionRef.effectId]) expect(serialized).not.toContain(hidden);
    expect(f.writes).toEqual(writes); expect(f.getShared).toHaveBeenCalledTimes(3); expect(f.inspectSession).toHaveBeenCalledTimes(3);
});

it('binds cursors to the snapshot and query scope, including branch filtering and checkpoint pagination', async () => {
    const f = fixture(); await create(f, 'a'); await create(f, 'b', 'other');
    const first = await f.reader({sessionId: 's', limit: 1});
    await expect(f.reader({sessionId: 's', branchId: 'main', cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_CURSOR_INVALID'});
    expect((await f.reader({sessionId: 's', branchId: 'other'})).bindings.map(binding => binding.ref.bindingId)).toEqual(['b']);
    await expect(f.reader({sessionId: 's', branchId: 'main', bindingId: 'b'})).rejects.toMatchObject({code: 'CONTEXT_BINDING_NOT_FOUND'});
    await create(f, 'c');
    await expect(f.reader({sessionId: 's', cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_CATALOG_CHANGED'});
});

it('rejects malformed requests before reading and reports storage failure or corrupt facts rather than an empty catalog', async () => {
    const f = fixture();
    for (const patch of [{limit: 0}, {limit: 101}, {sessionId: '../s'}, {cursor: null}, {cursor: {revision: 1, after: 'a'}}, {unknown: true}])
        await expect(f.reader({sessionId: 's', ...patch} as never)).rejects.toMatchObject({code: 'CONTEXT_QUERY_INVALID'});
    expect(f.getShared).not.toHaveBeenCalled();
    expect(await f.reader({sessionId: 's'})).toEqual({revision: null, bindings: []}); expect(f.writes).toEqual([]);
    await f.state.set(CONTEXT_BINDINGS_KEY, {version: 1, sessionId: 'foreign', bindings: {}});
    await expect(f.reader({sessionId: 's'})).rejects.toMatchObject({code: 'CONTEXT_STORAGE_INVALID'});
    f.getShared.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(f.reader({sessionId: 's'})).rejects.toMatchObject({code: 'CONTEXT_STORAGE_READ_FAILED'});
    f.getShared.mockRejectedValueOnce(Object.assign(new Error('Private authorization detail'), {code: 'EACCES'}));
    await expect(f.reader({sessionId: 's'})).rejects.toMatchObject({code: 'CONTEXT_STORAGE_READ_FAILED', remoteCode: 'EACCES'});
});

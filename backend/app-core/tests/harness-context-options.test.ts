import {expect, it, vi} from 'vitest';
import {contextOptionsFixture as fixture, addContextSource as add} from './harness-context-options-fixture';

it('qualifies cross-branch sources by exact identities with one passive profile inspection and safe projections', async () => {
    const f = fixture(); await add(f, 'a'); await add(f, 'b'); const writes = [...f.writes];
    const page = await f.reader(f.query);
    expect(page).toMatchObject({kind: 'direct-harness', branchId: 'destination', dynamicPolicy: 'dispatch-validation-required',
        modes: {new: {supported: true}, fork: {supported: true}, continue: {supported: false, code: 'CONTEXT_NATIVE_WRITE_UNSUPPORTED'}}});
    expect(page.sources.map(source => [source.ref.bindingId, source.branchId, source.fork.status])).toEqual([
        ['a', 'main', 'static-compatible'], ['b', 'main', 'static-compatible']]);
    expect(f.inspect).toHaveBeenCalledOnce(); expect(f.inspectSession).toHaveBeenCalledOnce(); expect(f.writes).toEqual(writes);
    const json = JSON.stringify(page);
    for (const hidden of ['private-thread', 'native-epoch', 'policy', 'fingerprint', 'nodeConnectionId', 'workspaceRef']) expect(json).not.toContain(hidden);
});

it('freezes exact source revisions and distinguishes terminal checkpoints from an unattributed legacy head', async () => {
    const f = fixture(); await add(f, 'a');
    const selected = await f.reader({...f.query, bindingId: 'a', checkpointRef: 'checkpoint-a'});
    expect(selected.checkpoints).toMatchObject([{ref: 'checkpoint-a', kind: 'terminal', fork: {status: 'static-compatible'}}]);
    const ref = structuredClone(selected.sources[0].ref);
    const stored = (f.records.get('harness.context.bindings')!.value as any).bindings.a;
    delete stored.checkpoints;
    const legacy = await f.reader({...f.query, bindingId: 'a'});
    expect(legacy.checkpoints).toMatchObject([{kind: 'legacy-head', fork: {status: 'unavailable', codes: ['CONTEXT_CHECKPOINT_UNCONFIRMED']}}]);
    expect(selected.sources[0].ref).toEqual(ref);
    await expect(f.reader({...f.query, bindingId: 'a', checkpointRef: 'missing'})).rejects.toMatchObject({code: 'CONTEXT_CHECKPOINT_CHANGED'});
});

it.each([
    [{connectionRef: 'changed'}, 'CONTEXT_CONNECTION_CHANGED'],
    [{workspaceRef: 'changed'}, 'CONTEXT_WORKSPACE_CHANGED'],
    [{memoryPolicyRef: 'changed'}, 'CONTEXT_MEMORY_POLICY_CHANGED'],
    [{validity: 'invalid', invalidReason: 'CONTEXT_POLICY_CHANGED'}, 'CONTEXT_BINDING_INVALID'],
] as const)('keeps mismatched static facts unavailable: %j', async (patch, code) => {
    const f = fixture(); await add(f, 'a', patch);
    expect((await f.reader(f.query)).sources[0].fork).toMatchObject({status: 'unavailable', codes: expect.arrayContaining([code])});
});

it('does not confuse endpoint IDs, unavailable fork bridges, native epoch drift, or an occupied source', async () => {
    const f = fixture(); await add(f, 'a'); f.inspection.epoch = 'new-epoch';
    expect((await f.reader(f.query)).sources[0].fork.codes).toContain('CONTEXT_NATIVE_EPOCH_CHANGED');
    f.inspection.epoch = 'native-epoch'; f.inspection.checkpointFork = false;
    expect((await f.reader(f.query)).modes.fork).toEqual({supported: false, code: 'CONTEXT_CHECKPOINT_FORK_UNSUPPORTED'});
    f.inspection.checkpointFork = true;
    const stored = (f.records.get('harness.context.bindings')!.value as any).bindings.a;
    stored.activeOperation = {operationId: 'busy', invocationId: 'busy-call', fingerprint: 'busy-fingerprint', executionRef: {taskId: 'busy-task', effectId: 'busy-effect'}};
    expect((await f.reader(f.query)).sources[0].fork.codes).toContain('CONTEXT_BINDING_BUSY');
});

it('binds pagination to destination, target, overrides, authorization, capabilities and catalog observations', async () => {
    const f = fixture(); await add(f, 'a'); await add(f, 'b'); const query = {...f.query, limit: 1};
    const first = await f.reader(query); expect(first.nextCursor).toBeDefined();
    expect((await f.reader({...query, cursor: first.nextCursor})).sources[0].ref.bindingId).toBe('b');
    for (const patch of [{branchId: 'main'}, {overrides: {systemPromptAppend: 'private append'}}, {overrides: {executionMode: 'agent' as const}}])
        await expect(f.reader({...query, ...patch, cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_OPTIONS_CHANGED'});
    f.inspection.snapshot.revision++;
    await expect(f.reader({...query, cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_OPTIONS_CHANGED'});
    f.inspection.snapshot.revision--; await add(f, 'c');
    await expect(f.reader({...query, cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_OPTIONS_CHANGED'});
});

it('returns other without network for legacy or published non-Harness targets but rejects missing published identities', async () => {
    const f = fixture(); f.definition.execution = {kind: 'agent'} as never;
    f.publication.definition.execution = {kind: 'agent'};
    const other = await f.reader(f.query);
    expect(other.kind).toBe('other'); expect(Object.values(other.modes)).toEqual(Array(3).fill({supported: false, code: 'CONTEXT_TARGET_UNSUPPORTED'}));
    expect(f.inspect).not.toHaveBeenCalled();
    f.agents.getAgentRevision.mockResolvedValue(null as never);
    expect((await f.reader(f.query)).kind).toBe('other');
    f.agents.getAgentRevision.mockImplementation(async (_id, version) => version ? null as never : f.publication);
    await expect(f.reader(f.query)).rejects.toMatchObject({code: 'CALL_TARGET_CHANGED'});
    f.agents.getAgentConfig.mockResolvedValue(null as never);
    await expect(f.reader(f.query)).rejects.toMatchObject({code: 'CALL_TARGET_CHANGED'});
    expect(f.inspect).not.toHaveBeenCalled();
});

it('rejects malformed requests before reads and preserves safe specific failures without a false empty page', async () => {
    const f = fixture();
    await expect(f.reader({...f.query, checkpointRef: 'head'})).rejects.toMatchObject({code: 'CONTEXT_OPTIONS_INVALID'});
    expect(f.sessions.getLoadState).not.toHaveBeenCalled();
    await expect(f.reader({...f.query, branchId: 'missing'})).rejects.toMatchObject({code: 'CONTEXT_QUERY_BRANCH_INVALID'});
    f.inspect.mockRejectedValueOnce(Object.assign(new Error('private native body'), {code: 'EACCES'}));
    await expect(f.reader(f.query)).rejects.toMatchObject({code: 'EACCES', message: 'Harness execution: EACCES'});
    f.inspectSession.mockRejectedValueOnce(Object.assign(new Error('private storage body'), {code: 'EIO'}));
    await expect(f.reader(f.query)).rejects.toMatchObject({code: 'CONTEXT_STORAGE_READ_FAILED', remoteCode: 'EIO'});
});

it.each(['epoch', 'authorization', 'destination-head', 'destination-profile', 'capability', 'target'] as const)
('rejects stale option cursors after %s drift', async changed => {
    const f = fixture(); await add(f, 'a'); await add(f, 'b'); const query = {...f.query, limit: 1};
    const first = await f.reader(query);
    if (changed === 'epoch') f.inspection.epoch = 'new-epoch';
    if (changed === 'authorization') f.inspection.snapshot.project = {...f.inspection.snapshot.project as any, authorization: {revision: 'new'}};
    if (changed === 'destination-head') f.state.manifest.branches.destination = 'new-head';
    if (changed === 'destination-profile') f.state.manifest.branchMeta.destination = {contextProfile: {id: 'profile', revision: 2}};
    if (changed === 'capability') f.inspection.profile.capabilities.checkpointFork = false;
    if (changed === 'target') f.query.target = {...f.query.target, version: `ap1_${'b'.repeat(64)}`, digest: 'b'.repeat(64)};
    if (changed === 'target') f.publication.target = f.query.target;
    await expect(f.reader({...query, target: f.query.target, cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_OPTIONS_CHANGED'});
});

it('filters unrelated source targets on the host and rejects exact-checkpoint pagination combinations before discovery', async () => {
    const f = fixture(); await add(f, 'a'); await add(f, 'other', {targetRef: 'agent:unrelated@version'});
    expect((await f.reader(f.query)).sources.map(source => source.ref.bindingId)).toEqual(['a']);
    expect((await f.reader({...f.query, bindingId: 'other', checkpointRef: 'checkpoint-other'})).sources[0].fork)
        .toMatchObject({status: 'unavailable', codes: expect.arrayContaining(['CONTEXT_TARGET_CHANGED'])});
    const first = await f.reader({...f.query, limit: 1}); const before = f.inspect.mock.calls.length;
    await expect(f.reader({...f.query, bindingId: 'a', checkpointRef: 'checkpoint-a', cursor: {basis: first.basis,
        catalog: {revision: first.revision!, after: 'a', scope: 'a'.repeat(64)}}})).rejects.toMatchObject({code: 'CONTEXT_OPTIONS_INVALID'});
    expect(f.inspect).toHaveBeenCalledTimes(before);
});

it('keeps source-directory and checkpoint cursors in their own scopes without extra profile discovery', async () => {
    const f = fixture(); await add(f, 'a'); await add(f, 'b');
    const first = await f.reader({...f.query, limit: 1});
    await expect(f.reader({...f.query, bindingId: 'a', cursor: first.nextCursor})).rejects.toMatchObject({code: 'CONTEXT_CURSOR_INVALID'});
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect((await f.reader({...f.query, bindingId: 'a', checkpointRef: 'checkpoint-a'})).sources[0].ref.bindingId).toBe('a');
    expect(f.inspect).toHaveBeenCalledTimes(3);
});

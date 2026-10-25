import {expect, it, vi} from 'vitest';
import {HarnessContextBindings, CONTEXT_BINDINGS_KEY} from '../src/projects/harness-context-bindings';
import {harnessExecutionJournalKey} from '../src/projects/harness-execution';
import {context} from './harness-context-fixture';
import {complete, fixture, request} from './harness-execution-fixture';

const call = {...request, context};
function store(f: ReturnType<typeof fixture>) {return new HarnessContextBindings(f.state, f.context.sessionId);}
function saved(f: ReturnType<typeof fixture>) {return f.records.get(harnessExecutionJournalKey(f.context))!.value as any;}

it('persists binding ownership before native creation and returns an independently identified context', async () => {
    const f = fixture();
    vi.mocked(f.client.create).mockImplementation(async (_profile, _workspace, options) => {
        const binding = await store(f).get(saved(f).bindingId);
        expect(binding).toMatchObject({validity: 'pending', activeOperation: {invocationId: context.invocationId,
            executionRef: {taskId: f.context.taskId, effectId: f.context.effectId}}});
        expect(binding?.nativeRef).toBeUndefined();
        return f.committed(options, {session: f.session}) as {session: typeof f.session};
    });
    complete(f); const result = await f.make().execute(call, f.context), records = await store(f).list();
    expect(records).toHaveLength(1); expect(result.contextBinding?.bindingId).toBe(records[0].id);
    expect(records[0].id).not.toBe(context.invocationId); expect(records[0].id).not.toBe(f.context.taskId);
    expect(records[0]).toMatchObject({validity: 'valid', knownHeadRef: 'native-turn', nativeRef: {sessionId: 'native-session'}});
    expect(records[0].activeOperation).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain(request.prompt);
    const diagnostics = JSON.stringify(vi.mocked(f.context.emit!).mock.calls);
    expect(diagnostics).not.toContain(request.prompt); expect(diagnostics).not.toContain('First answer');
    expect(f.context.emit).toHaveBeenCalledWith({type: 'harness:execution', payload: expect.objectContaining({
        stage: 'context-binding', outcome: 'claimed', invocationId: context.invocationId, bindingId: records[0].id,
    })});
});

it('reconciles the original binding and turn after a lost remote reply without another native mutation', async () => {
    const f = fixture(); vi.mocked(f.client.turn).mockImplementationOnce(async (_profile, _session, _prompt, options) => {
        f.committed(options, {turnId: 'native-turn'}); complete(f); throw new Error('Reply lost');
    });
    await expect(f.make().execute(call, f.context)).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
    const bindingId = saved(f).bindingId;
    expect((await store(f).get(bindingId))?.activeOperation).toBeDefined();
    expect(await f.make().reconcile(call, f.context)).toMatchObject({status: 'completed', result: {contextBinding: {bindingId}}});
    expect(await store(f).list()).toHaveLength(1); expect(f.client.turn).toHaveBeenCalledOnce(); expect(f.client.create).toHaveBeenCalledOnce();
});

it.each(['journal', 'release'])('keeps ownership until the settlement %s write is durable and recovers it', async stage => {
    const f = fixture(), set = f.state.set.bind(f.state); let failed = false;
    vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
        const data = value as any;
        if (!failed && (stage === 'journal' ? key === harnessExecutionJournalKey(f.context) && data.bindingSettlement
            : key === CONTEXT_BINDINGS_KEY && Object.values(data.bindings).some((binding: any) => binding.lastOperation && !binding.activeOperation))) {
            failed = true; throw new Error('Settlement storage unavailable');
        }
        return set(key, value, version);
    });
    complete(f); await expect(f.make().execute(call, f.context)).rejects.toMatchObject(stage === 'journal'
        ? {message: 'Settlement storage unavailable'} : {code: 'CONTEXT_STORAGE_WRITE_FAILED'});
    expect((await store(f).list())[0].activeOperation).toBeDefined();
    expect(await f.make().reconcile(call, f.context)).toMatchObject({status: 'completed'});
    expect((await store(f).list())[0].activeOperation).toBeUndefined(); expect(f.client.turn).toHaveBeenCalledOnce();
});

it('recovers an old result after another call has claimed the context without releasing the new owner', async () => {
    const f = fixture(), set = f.state.set.bind(f.state); let failed = false;
    vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
        if (!failed && key === harnessExecutionJournalKey(f.context) && (value as any).result) {
            failed = true; throw new Error('Result storage unavailable');
        }
        return set(key, value, version);
    });
    complete(f); await expect(f.make().execute(call, f.context)).rejects.toThrow('Result storage unavailable');
    const binding = (await store(f).list())[0], receipt = saved(f).bindingSettlement.ref;
    const next = {...context, invocationId: 'next-call', input: {mode: 'native-continuation' as const, inputRef: 'increment', digest: 'increment-hash'},
        conversation: {mode: 'continue' as const, bindingId: binding.id, expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}};
    await store(f).claim(binding.id, next, request.connection, {operationId: 'next-operation', invocationId: 'next-call', fingerprint: 'next-hash',
        executionRef: {taskId: 'next-task', effectId: 'next-effect'}});
    expect(await f.make().reconcile(call, f.context)).toMatchObject({status: 'completed', result: {contextBinding: receipt}});
    expect((await store(f).get(binding.id))?.activeOperation?.operationId).toBe('next-operation');
});

it('refuses native continuation before acquiring a connection when conditional write capability is unavailable', async () => {
    const f = fixture(), continuation = {...call, context: {...context, input: {mode: 'native-continuation' as const, inputRef: 'increment', digest: 'hash'},
        conversation: {mode: 'continue' as const, bindingId: 'binding', expectedBindingRevision: 1, expectedGeneration: 1}}};
    await expect(f.make().execute(continuation, f.context)).rejects.toMatchObject({code: 'CONTEXT_NATIVE_WRITE_UNSUPPORTED', executionOutcome: 'not-started'});
    expect(f.connections.acquire).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled(); expect(f.records.size).toBe(0);
});

it.each(['create', 'turn'] as const)('releases a binding only after an authoritative %s rejection', async step => {
    const f = fixture(); vi.mocked(f.client[step]).mockRejectedValueOnce(Object.assign(new Error('Rejected fixture operation'),
        {code: 'HARNESS_REQUEST_REJECTED', outcome: 'not-committed'}));
    await expect(f.make().execute(call, f.context)).rejects.toMatchObject({code: 'HARNESS_REQUEST_REJECTED', executionOutcome: 'not-started'});
    const binding = (await store(f).list())[0]; expect(binding.activeOperation).toBeUndefined();
    expect(binding.validity).toBe(step === 'create' ? 'invalid' : 'valid');
    expect(saved(f).bindingSettlement.kind).toBe('not-started');
});

it('keeps the binding occupied when cancellation cannot confirm stopping, then releases on exact terminal evidence', async () => {
    const f = fixture(), provider = f.make(), running = provider.execute(call, f.context).catch(error => error);
    await vi.waitFor(() => expect(f.client.turn).toHaveBeenCalledOnce());
    f.controller.abort(); await running;
    await expect(provider.cancel(call, f.context)).rejects.toBeInstanceOf(Error);
    expect((await store(f).list())[0].activeOperation).toBeDefined();
    complete(f, 'cancelled'); await provider.cancel(call, f.context);
    expect((await store(f).list())[0].activeOperation).toBeUndefined();
    expect(f.client.interrupt).toHaveBeenCalledOnce();
});

it('rejects a corrupted binding receipt before replaying a saved result or contacting the service', async () => {
    const f = fixture(); complete(f); await f.make().execute(call, f.context);
    const entry = f.records.get(harnessExecutionJournalKey(f.context))!, data = structuredClone(entry.value) as any;
    data.bindingSettlement.ref.bindingId = 'another-binding';
    f.records.set(entry.key, {...entry, value: data}); f.connections.acquire.mockClear();
    expect(await f.make().reconcile(call, f.context)).toMatchObject({status: 'unknown', code: 'JOURNAL_CONFLICT'});
    expect(f.connections.acquire).not.toHaveBeenCalled(); expect(f.client.turn).toHaveBeenCalledOnce();
});

import {afterEach, expect, it, vi} from 'vitest';
import type {Kernel, SessionHandle} from '@itookit/durable-kernel';
import {createHarnessContextCleanup} from '../src/projects/harness-context-cleanup';
import {CONTEXT_BINDINGS_KEY, HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {ExecutionJournal, type ExecutionJournalData} from '../src/projects/harness-execution-journal';
import {fixture as executionFixture, request} from './harness-execution-fixture';
import {context} from './harness-context-fixture';
import {createHarnessExecutionProvider} from '../src/projects/harness-execution';
import {getLogger} from '@itookit/common';

afterEach(() => vi.restoreAllMocks());

async function fixture(terminal = true) {
    const f = executionFixture(), call = {...request, context}, journal = new ExecutionJournal(f.state, f.context, call);
    await journal.initialize('service-epoch');
    const store = new HarnessContextBindings(f.state, f.context.sessionId), id = journal.data.bindingId!;
    await store.claim(id, context, request.connection, journal.contextOperation());
    await store.attach(id, journal.contextOperation().operationId, {nodeConnectionId: 'node', profileId: 'claude', workspaceId: 'workspace',
        sessionId: 'native-session', epoch: 'service-epoch'});
    await journal.save({sessionId: 'native-session', ...(terminal ? {turnId: 'native-turn', terminal: 'cancelled' as const} : {}), operations: {
        create: {requestId: 'create', outcome: 'committed', result: {session: {id: 'native-session'}}},
        turn: terminal ? {requestId: 'turn', outcome: 'committed', result: {turnId: 'native-turn'}} : {requestId: 'turn', outcome: 'pending'},
    }});
    const session = {getShared: f.state.get, setShared: (key: string, value: any, options?: {expectedVersion?: number | null}) => f.state.set(key, value, options?.expectedVersion)};
    const openSession = vi.fn(async () => session as unknown as SessionHandle), gate = vi.fn(async (_id: string) => {});
    const cleanup = createHarnessContextCleanup(() => ({openSession} as Pick<Kernel, 'openSession'>), gate);
    return {...f, call, journal, store, id, openSession, gate, cleanup};
}

async function unrelated(f: Awaited<ReturnType<typeof fixture>>, id = 'independent') {
    return f.store.claim(id, {...context, invocationId: id}, request.connection, {operationId: id, invocationId: id,
        fingerprint: `${id}-fingerprint`, executionRef: {taskId: `${id}-task`, effectId: 'effect'}});
}
function persisted(f: Awaited<ReturnType<typeof fixture>>): ExecutionJournalData {
    return f.records.get(f.journal.key)!.value as unknown as ExecutionJournalData;
}

it('settles only its original binding and publishes one checkpoint without touching unrelated ownership', async () => {
    const f = await fixture(), other = await unrelated(f);
    const result = await f.cleanup(f.journal, false, f.context);
    expect(result?.bindingId).toBe(f.id);
    expect(await f.store.get('independent')).toEqual(other);
    const own = await f.store.get(f.id);
    expect(own?.activeOperation).toBeUndefined(); expect(own?.checkpoints).toHaveLength(1);
    expect(own?.checkpoints?.[0]).toMatchObject({ref: 'native-turn', operation: f.journal.contextOperation()});
    expect(persisted(f).bindingSettlement?.ref).toEqual(result);
    await f.cleanup(f.journal, false, f.context);
    expect((await f.store.get(f.id))?.checkpoints).toHaveLength(1);
});

it('loads authoritative journal facts rather than a forged in-memory target or head', async () => {
    const f = await fixture(), other = await unrelated(f);
    f.journal.data.bindingId = 'independent'; f.journal.data.turnId = 'invented-head';
    const result = await f.cleanup(f.journal, false, f.context);
    expect(result?.bindingId).toBe(f.id); expect((await f.store.get(f.id))?.knownHeadRef).toBe('native-turn');
    expect(await f.store.get('independent')).toEqual(other);
});

it.each([false, true])('retains ownership when journal persistence fails (committed before lost reply: %s)', async committed => {
    const f = await fixture(), save = f.state.set.bind(f.state); let failed = false;
    vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
        if (!failed && key === f.journal.key && (value as any).bindingSettlement) {
            failed = true; if (committed) await save(key, value, version);
            throw Object.assign(new Error('PRIVATE_STORAGE_ERROR'), {code: 'EIO'});
        }
        return save(key, value, version);
    });
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'EIO'});
    expect((await f.store.get(f.id))?.activeOperation).toBeDefined();
    expect((await f.store.get(f.id))?.checkpoints).toBeUndefined();
    await f.cleanup(f.journal, false, f.context);
    expect((await f.store.get(f.id))?.activeOperation).toBeUndefined();
    expect((await f.store.get(f.id))?.checkpoints).toHaveLength(1);
});

it('retries a real collection CAS conflict while preserving a concurrent independent binding', async () => {
    const f = await fixture(), save = f.state.set.bind(f.state); let raced = false;
    vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
        if (!raced && key === CONTEXT_BINDINGS_KEY && (value as any).bindings[f.id].settlement) {
            raced = true; await unrelated(f, 'concurrent');
        }
        return save(key, value, version);
    });
    await f.cleanup(f.journal, false, f.context);
    expect(raced).toBe(true); expect((await f.store.get('concurrent'))?.activeOperation?.operationId).toBe('concurrent');
    expect((await f.store.get(f.id))?.checkpoints).toHaveLength(1);
});

it('does not release a newer owner after the original release acknowledgement is lost', async () => {
    const f = await fixture(), save = f.state.set.bind(f.state); let lost = false, successor: unknown;
    vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
        const current = key === CONTEXT_BINDINGS_KEY && (value as any).bindings[f.id];
        if (!lost && current?.lastOperation && !current.activeOperation) {
            lost = true; await save(key, value, version);
            const operation = {...f.journal.contextOperation(), operationId: 'next-owner', invocationId: 'next-call', fingerprint: 'next-input'};
            successor = await f.store.claim(f.id, {...context, invocationId: 'next-call', input: {mode: 'native-continuation', inputRef: 'increment', digest: 'next'},
                conversation: {mode: 'continue', bindingId: f.id, expectedBindingRevision: current.revision, expectedGeneration: current.generation}}, request.connection, operation);
            throw new Error('Release acknowledgement lost');
        }
        return save(key, value, version);
    });
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'CONTEXT_STORAGE_WRITE_FAILED'});
    await f.cleanup(f.journal, false, f.context);
    expect(await f.store.get(f.id)).toEqual(successor);
});

it('rejects foreign execution identity and lost Session ownership before opening Kernel storage', async () => {
    const f = await fixture(), before = structuredClone([...f.records]);
    await expect(f.cleanup(f.journal, false, {...f.context, effectId: 'foreign'})).rejects.toMatchObject({code: 'CLEANUP_CONTEXT_MISMATCH'});
    f.gate.mockRejectedValue(Object.assign(new Error('Private lease detail'), {code: 'EACCES'}));
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'EACCES'});
    expect(f.openSession).not.toHaveBeenCalled(); expect([...f.records]).toEqual(before);
});

it.each(['operation', 'native'])('keeps the binding occupied when the %s identity does not match the original journal', async kind => {
    const f = await fixture(), binding = (f.records.get(CONTEXT_BINDINGS_KEY)!.value as any).bindings[f.id];
    if (kind === 'operation') binding.activeOperation.fingerprint = 'foreign'; else binding.nativeRef.sessionId = 'foreign-thread';
    const before = structuredClone([...f.records]);
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: kind === 'operation'
        ? 'CLEANUP_BINDING_OWNER_MISMATCH' : 'CLEANUP_NATIVE_IDENTITY_MISMATCH'});
    expect([...f.records]).toEqual(before);
});

it('refuses both cleanup kinds while native admission or terminal evidence is unknown', async () => {
    const f = await fixture(false), before = structuredClone([...f.records]);
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'CLEANUP_BINDING_STOP_UNCONFIRMED'});
    await expect(f.cleanup(f.journal, true, f.context)).rejects.toMatchObject({code: 'CLEANUP_BINDING_START_UNCONFIRMED'});
    expect([...f.records]).toEqual(before);
});

it('requires the persisted binding generation on release and retains ownership if the receipt is corrupt', async () => {
    const f = await fixture(), operationId = f.journal.contextOperation().operationId;
    const prepared = await f.store.prepareSettlement(f.id, operationId, {operationId, kind: 'terminal', knownHeadRef: 'native-turn'});
    await f.journal.save({bindingSettlement: {kind: 'terminal', knownHeadRef: 'native-turn', ref: {bindingId: f.id, revision: prepared.revision + 1, generation: 99}}});
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'CLEANUP_BINDING_RECEIPT_INVALID'});
    expect((await f.store.get(f.id))?.activeOperation).toBeDefined();
});

it.each(['kind', 'head'])('rejects a prepared %s that differs from the durable journal release proof', async field => {
    const f = await fixture(), operationId = f.journal.contextOperation().operationId;
    const prepared = await f.store.prepareSettlement(f.id, operationId, {operationId, kind: 'terminal', knownHeadRef: 'native-turn'});
    await f.journal.save({bindingSettlement: {kind: 'terminal', knownHeadRef: 'native-turn',
        ref: {bindingId: f.id, revision: prepared.revision + 1, generation: prepared.generation}}});
    const binding = (f.records.get(CONTEXT_BINDINGS_KEY)!.value as any).bindings[f.id];
    if (field === 'kind') binding.settlement.kind = 'not-started'; else binding.settlement.knownHeadRef = 'foreign-head';
    const before = structuredClone([...f.records]);
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'CLEANUP_BINDING_RECEIPT_INVALID'});
    expect([...f.records]).toEqual(before);
});

it('releases a claimed binding cancelled before any native creation without publishing a checkpoint', async () => {
    const f = await fixture(), pending = new ExecutionJournal(f.state, f.context, f.call);
    await pending.load();
    await pending.save({operations: {}, sessionId: undefined, turnId: undefined, terminal: undefined});
    const collection = f.records.get(CONTEXT_BINDINGS_KEY)!.value as any;
    delete collection.bindings[f.id].nativeRef; collection.bindings[f.id].validity = 'pending';
    await expect(f.cleanup(pending, true, f.context)).resolves.toMatchObject({bindingId: f.id});
    expect(await f.store.get(f.id)).toMatchObject({validity: 'invalid', invalidReason: 'CONTEXT_NATIVE_REFERENCE_UNCONFIRMED'});
    expect((await f.store.get(f.id))?.activeOperation).toBeUndefined();
    expect((await f.store.get(f.id))?.checkpoints).toBeUndefined();
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
});

it('does not confirm cancellation when a context-aware provider has only a journal cleanup capability', async () => {
    const f = await fixture(), before = structuredClone([...f.records]);
    const provider = createHarnessExecutionProvider(f.connections, {stateForCleanup: async () => f.state});
    await expect(provider.cancel(f.call, f.context)).rejects.toMatchObject({code: 'CLEANUP_BINDING_UNAVAILABLE'});
    expect([...f.records]).toEqual(before); expect(f.connections.acquire).not.toHaveBeenCalled();
});

it('rechecks the lease after preparing a binding and retains it when journal persistence loses ownership', async () => {
    const f = await fixture(), save = f.state.set.bind(f.state);
    vi.spyOn(f.state, 'set').mockImplementation(async (key, value, revision) => {
        const saved = await save(key, value, revision);
        if (key === CONTEXT_BINDINGS_KEY) f.gate.mockRejectedValue(Object.assign(new Error('Private lost lease'), {code: 'EACCES'}));
        return saved;
    });
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'EACCES'});
    expect(persisted(f).bindingSettlement).toBeUndefined();
    expect((await f.store.get(f.id))?.activeOperation).toBeDefined();
    expect((await f.store.get(f.id))?.checkpoints).toBeUndefined();
    f.gate.mockResolvedValue(); await f.cleanup(f.journal, false, f.context);
    expect((await f.store.get(f.id))?.activeOperation).toBeUndefined();
});

it('logs scoped cleanup stages and safe codes without input, storage details or native identities', async () => {
    getLogger().clear();
    const f = await fixture();
    await f.journal.save({turnId: 'PRIVATE_NATIVE_TURN'});
    f.gate.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_STORAGE_BODY'), {code: 'EACCES'}));
    await expect(f.cleanup(f.journal, false, f.context)).rejects.toMatchObject({code: 'EACCES'});
    await f.cleanup(f.journal, false, f.context);
    const logs = JSON.stringify(getLogger().query({modules: ['HarnessContextCleanup']}));
    expect(logs).toContain('journal-verification'); expect(logs).toContain('EACCES'); expect(logs).toContain('settled');
    for (const secret of [request.prompt, 'PRIVATE_STORAGE_BODY', 'native-session', 'PRIVATE_NATIVE_TURN']) expect(logs).not.toContain(secret);
});

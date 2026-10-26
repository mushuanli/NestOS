import * as identity from '../src/persistence/ulid';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Kernel, type SessionHandle} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend, type IVFSManager} from '@itookit/vfs-core';
import {registerDurablePrograms} from '@itookit/llm-flow';
import type {InvocationIdentity} from '@itookit/llm-flow/contracts';
import {HarnessProgram, HarnessExecutionEffect} from '@itookit/kernel-adapters';
import {sha256HexSync} from '@itookit/llm-context';
import {IndependentCallService, prepareDirectConversationRun, type IndependentTaskCallPreparation} from '../src';
import {ContentTransferService} from '../src/session/content-transfers';
import {CommandBus} from '../src/core/command-bus';
import {SessionRepository} from '../src/persistence/session-repository';
import {RoundLog} from '../src/persistence/round-log';
import {SessionDirectoryStorageResolver, sessionDirectoryStorage} from '../src/persistence/session-directory-storage';
import type {IndependentCallInput} from '../src/contracts/independent-calls';
import type {SubmissionRequest} from '../src/contracts/submission';
import {submissionInstruction} from '../src/session/submission-input';
import {InstructionQueueStore} from '../src/persistence/instruction-queue-store';
import {prepareInstruction, instructionDigest} from '../src/session/instruction-queue-rules';

let manager: IVFSManager, kernel: Kernel, repository: SessionRepository, parent: string, service: IndependentCallService;
let transfers: ContentTransferService, fs: Awaited<ReturnType<IVFSManager['openFileSystem']>>;
const submit = vi.fn(async (_request: SubmissionRequest) => 'call'), logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const model = vi.fn(async () => ({choices: [{message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}]}));
const native = vi.fn(async () => ({text: 'Native done', sessionId: 'native', turnId: 'turn'}));
const target = {kind: 'agent' as const, id: 'reviewer', version: '1', digest: 'a'.repeat(64)};
const key = 'conversation/call/call';
function input(): IndependentCallInput {return {title: 'PRIVATE TITLE', request: {expectedSessionId: parent, expectedBranch: 'main',
    target: {kind: 'agent', id: target.id, version: target.version}, expectedTarget: target, source: {kind: 'composer', text: 'PRIVATE INPUT', attachments: [], values: {}},
    submission: {id: 'call', source: {kind: 'conversation', ownerId: parent, id: 'call'}}}};}
function createService(canWrite?: (id: string) => Promise<boolean>) {
    return new IndependentCallService({kernel, repository, transfers, submit, canWrite, hostPorts: {logger}});
}
async function createKernel() {
    const result = new Kernel({catalog: {fs}, maxConcurrentEffects: 1, onDiagnostic: () => {}});
    result.registerStorageResolver(new SessionDirectoryStorageResolver(fs)); registerDurablePrograms(result); result.registerProgram(new HarnessProgram());
    result.registerEffect({kind: 'llm.chat', version: '1', execute: model});
    result.registerEffect(new HarnessExecutionEffect({execute: native, cancel: async (_request, context) => ({status: 'stopped', cleanup: 'confirmed',
        evidence: {sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'terminal'}}),
        reconcile: async (_request, context) => ({status: 'not-started', evidence: {sessionId: context.sessionId,
            taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'not-started'}})}));
    await result.initialize(); return result;
}
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); fs = await manager.openFileSystem('/'); kernel = await createKernel();
    repository = new SessionRepository(fs, async id => {await kernel.createSession({id, storage: sessionDirectoryStorage(id)});});
    await repository.init(); parent = await repository.createSession('Parent');
    transfers = new ContentTransferService({kernel, repository, commands: new CommandBus()}); service = createService(); vi.clearAllMocks();
});
afterEach(async () => {vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();});
function options(kind: 'chat' | 'agent' | 'harness' = 'chat'): IndependentTaskCallPreparation {
    return {maxDepth: 3, timeoutMs: null, prepare: async (request, invocation) => prepare(request, invocation, kind)};
}
async function prepare(request: SubmissionRequest, invocation: InvocationIdentity, kind = 'chat') {
    const sessionId = request.expectedSessionId!, instruction = submissionInstruction(request);
    return prepareDirectConversationRun({task: {id: `prepare-${invocation.invocationId}`, sessionId,
        input: {...instruction, sessionId, invocation, overrides: {...instruction.overrides, executionMode: kind === 'agent' ? 'agent' : 'chat'}}},
        roundId: request.submission!.id, log: new RoundLog(repository, sessionId), contextFiles: instruction.files,
        config: {id: 'reviewer', name: 'Reviewer', type: 'agent', connectionId: 'model', stream: false, target,
            ...(kind === 'harness' ? {execution: {kind: 'harness', connectionId: 'remote'}, harnessConnection: {version: 1, revision: 1,
                id: 'remote', name: 'Remote', kind: 'harness', nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: {root: '/workspace'}}} : {})}},
    {engine: repository, loadArtifact: async () => null, hasProgram: (name, version) => kernel.programs.has(name, version),
        resolveHarnessToolIds: async () => ['inspect'], resolveTools: async () => ({definitions: [{name: 'inspect'}], externalIds: []})});
}
function deferred<T = void>() {let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function interceptWrites(write: (session: SessionHandle, args: Parameters<SessionHandle['setShared']>) => Promise<unknown>) {
    const open = kernel.openSession.bind(kernel);
    return vi.spyOn(kernel, 'openSession').mockImplementation(async id => {
        const session = await open(id); return new Proxy(session, {get(owner, property) {
            if (property === 'setShared') return (...args: Parameters<SessionHandle['setShared']>) => write(session, args);
            const value = Reflect.get(owner, property, owner); return typeof value === 'function' ? value.bind(owner) : value;
        }});
    });
}
it('freezes one business Invocation and a ready Kernel plan in the existing route without executing or accepting the queue', async () => {
    const configured = options(), compile = vi.fn(configured.prepare); configured.prepare = compile;
    expect(await service.inspectPreparedTaskCall(input())).toBeUndefined();
    const ready = await service.prepareTaskCall(input(), configured);
    expect(ready.caller).toEqual({sessionId: parent, requestId: 'independent-call:call'});
    expect(ready.plan).toMatchObject({targetSessionId: ready.executionSessionId, maxDepth: 3, timeoutMs: null,
        task: {labels: {invocationId: ready.invocation.invocationId, roundId: 'call', targetId: target.id}}});
    const allocate = vi.spyOn(identity, 'ulid');
    expect(await createService().prepareTaskCall(input(), configured)).toEqual(ready); expect(compile).toHaveBeenCalledOnce();
    expect(allocate).not.toHaveBeenCalled();
    expect(compile.mock.calls[0][0]).toMatchObject({expectedSessionId: ready.executionSessionId,
        submission: {source: {kind: 'independent-call', ownerId: parent}}});
    expect(await repository.list()).toHaveLength(2); expect(await repository.listHistory(ready.executionSessionId)).toEqual([]);
    expect(await service.inspect(input())).toMatchObject({status: 'unknown', executionSessionId: ready.executionSessionId});
    expect(await kernel.listSessionTasks(parent)).toEqual([]); expect(await kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
    expect(submit).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
});
it.each(['chat', 'agent', 'harness'] as const)('reloads the original %s plan after a Kernel restart and executes it without preparation', async kind => {
    const first = await service.prepareTaskCall(input(), options(kind)); kernel.dispose(); await kernel.waitIdle(); kernel = await createKernel();
    transfers = new ContentTransferService({kernel, repository, commands: new CommandBus()}); const restored = createService(), configured = options(kind);
    configured.prepare = vi.fn(async () => {throw Error('Do not read new configuration');});
    const ready = await restored.prepareTaskCall(input(), configured); expect(ready).toEqual(first); expect(configured.prepare).not.toHaveBeenCalled();
    const caller = await kernel.submit(ready.caller.sessionId, {program: {kind: 'kernel.call', version: '2'}, input: ready.plan, requestId: ready.caller.requestId, deferStart: true});
    await kernel.bindTaskCall({sessionId: parent, taskId: caller.id}, ready.plan);
    expect(await caller.wait({until: 'settled', timeoutMs: 3000})).toMatchObject({status: 'succeeded', output: {task: {sessionId: ready.executionSessionId},
        exit: {output: {message: {content: kind === 'harness' ? 'Native done' : 'Done'}}}}});
    expect((await kernel.listSessionTasks(ready.executionSessionId))[0].ownedBy).toMatchObject({sessionId: parent, taskId: caller.id});
    expect(await restored.inspectPreparedTaskCall(input())).toEqual(first);
});
it('replays a lost plan write response by observing the original committed plan', async () => {
    let lost = false; interceptWrites(async (session, args) => {
        const result = await session.setShared(...args);
        if (!lost && args[0] === key && (args[1] as any).kernelPreparation?.prepared) {lost = true; throw Object.assign(Error('PRIVATE LOST REPLY'), {code: 'ETIMEDOUT'});}
        return result;
    });
    const configured = options(), compile = vi.fn(configured.prepare); configured.prepare = compile;
    const first = await service.prepareTaskCall(input(), configured); expect(lost).toBe(true);
    expect(await service.prepareTaskCall(input(), configured)).toEqual(first); expect(compile).toHaveBeenCalledOnce();
});
it('keeps the original claim after preparation fails and retries without inventing a new Invocation or child', async () => {
    const seen: string[] = [], configured = options(); let fail = true;
    configured.prepare = async (request, invocation) => {seen.push(invocation.invocationId);
        if (fail) {fail = false; throw Object.assign(Error('PRIVATE FAILURE'), {code: 'EIO'});} return prepare(request, invocation);};
    await expect(service.prepareTaskCall(input(), configured)).rejects.toHaveProperty('code', 'EIO');
    expect(await service.inspectPreparedTaskCall(input())).toBeUndefined(); const ready = await createService().prepareTaskCall(input(), configured);
    expect(seen).toEqual([ready.invocation.invocationId, ready.invocation.invocationId]); expect(await repository.list()).toHaveLength(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE FAILURE');
});
it('uses the committed CAS winner when independent hosts prepare different valid snapshots concurrently', async () => {
    const gate = deferred(), reached = deferred(); let count = 0; const seen: string[] = [], configured = options();
    configured.prepare = async (request, invocation) => {const index = ++count; seen.push(invocation.invocationId); if (count === 2) reached.resolve();
        await gate.promise; const ready = await prepare(request, invocation); (ready.definition.task.input as any).temperature = index; return ready;};
    const first = service.prepareTaskCall(input(), configured), second = createService().prepareTaskCall(input(), configured);
    const both = Promise.all([first, second]);
    try {await Promise.race([reached.promise, both.then(() => {})]);} finally {gate.resolve();}
    const [a, b] = await both;
    expect(a).toEqual(b); expect(new Set(seen).size).toBe(1); expect(await repository.list()).toHaveLength(2);
});
it('inspects a prepared route cold and returns detached data without taking a writer or running preparation', async () => {
    const ready = await service.prepareTaskCall(input(), options()), open = vi.spyOn(kernel, 'openSession'), recover = vi.spyOn(kernel, 'recoverSession');
    const denied = vi.fn(async () => false); const observed = await createService(denied).inspectPreparedTaskCall(input());
    expect(observed).toEqual(ready); expect(denied).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
    observed!.plan.task.input = 'changed'; expect(await service.inspectPreparedTaskCall(input())).toEqual(ready);
});
it('rejects a changed request or deadline policy before re-reading providers or creating a second child', async () => {
    await service.prepareTaskCall(input(), options()); const configured = options(); configured.prepare = vi.fn(configured.prepare);
    await expect(service.prepareTaskCall({...input(), title: 'Changed'}, configured)).rejects.toHaveProperty('code', 'CALL_REQUEST_CONFLICT');
    await expect(service.prepareTaskCall(input(), {...configured, maxDepth: 4})).rejects.toHaveProperty('code', 'CALL_PREPARATION_POLICY_CONFLICT');
    await expect(service.prepareTaskCall(input(), {...configured, timeoutMs: 60_000})).rejects.toHaveProperty('code', 'CALL_PREPARATION_POLICY_CONFLICT');
    expect(configured.prepare).not.toHaveBeenCalled(); expect(await repository.list()).toHaveLength(2);
});
it('prevents both directions of queue/Kernel reinterpretation under one call identity', async () => {
    await service.prepareTaskCall(input(), options()); await expect(service.submit(input())).rejects.toHaveProperty('code', 'CALL_EXECUTION_MODE_CONFLICT');
    const legacy = input(); legacy.request.submission!.id = legacy.request.submission!.source.id = 'queue-call';
    submit.mockImplementationOnce(async request => {const store = new InstructionQueueStore(kernel), queue = await store.read(request.expectedSessionId!);
        const item = prepareInstruction(submissionInstruction(request), request.expectedSessionId!, 'main');
        await store.write({...queue, accepted: [{id: item.id, digest: await instructionDigest(item)}]}); return item.id;});
    expect((await service.submit(legacy)).status).toBe('accepted');
    await expect(service.prepareTaskCall(legacy, options())).rejects.toHaveProperty('code', 'CALL_EXECUTION_MODE_CONFLICT');
    expect(submit).toHaveBeenCalledOnce();
});
it.each(['target', 'invocation', 'round', 'context'] as const)('rejects a host-prepared %s mismatch without persisting it or executing', async mismatch => {
    const configured = options(); configured.prepare = async (request, invocation) => {
        const ready = await prepare(request, invocation);
        if (mismatch === 'target') ready.definition.sessionId = parent;
        if (mismatch === 'invocation') ready.definition.task.labels!.invocationId = 'foreign';
        if (mismatch === 'round') ready.definition.task.labels!.roundId = 'foreign';
        if (mismatch === 'context') ready.context.branchHead = 'unrelated-history'; return ready;
    };
    await expect(service.prepareTaskCall(input(), configured)).rejects.toHaveProperty('code', 'CALL_PREPARATION_SCOPE_MISMATCH');
    expect(await service.inspectPreparedTaskCall(input())).toBeUndefined(); expect(model).not.toHaveBeenCalled();
});
it('detects a damaged persisted plan and preserves a safe concrete diagnostic', async () => {
    const ready = await service.prepareTaskCall(input(), options()), owner = await kernel.openSession(parent), saved = (await owner.getShared(key))!;
    const data = structuredClone(saved.value) as any; data.kernelPreparation.prepared.plan.task.input = 'PRIVATE TAMPER';
    await owner.setShared(key, data, {expectedVersion: saved.version});
    await expect(service.inspectPreparedTaskCall(input())).rejects.toHaveProperty('code', 'CALL_PREPARATION_CORRUPT');
    expect(logger.warn).toHaveBeenCalledWith('Independent call preparation', expect.objectContaining({operation: 'call.prepare.inspect', stage: 'plan',
        errorCode: 'CALL_PREPARATION_CORRUPT', outcome: 'failure', operationId: 'call', durationMs: expect.any(Number)}));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE TAMPER'); expect(await kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
});
it('reuses inline prepared files after the source file is gone and avoids copying it again', async () => {
    const request = input(), data = new TextEncoder().encode('Document body'); await repository.writeAttachment(parent, 'notes.txt', data.buffer);
    request.request.attachments = [{name: 'notes.txt', type: 'text/plain', size: data.byteLength,
        content: {sha256: sha256HexSync(data.buffer), bytes: data.byteLength}}];
    const ready = await service.prepareTaskCall(request, options('harness')), read = vi.spyOn(repository, 'readSessionAsset').mockRejectedValue(Error('File unavailable'));
    expect(await createService().prepareTaskCall(request, options('harness'))).toEqual(ready); expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(ready.plan.task.input)).toContain('Document body');
});
it.each([0, NaN, Infinity])('rejects invalid depth %s before creating a route or reading providers', async maxDepth => {
    const configured = options(); configured.prepare = vi.fn(configured.prepare);
    await expect(service.prepareTaskCall(input(), {...configured, maxDepth})).rejects.toHaveProperty('code', 'CALL_PREPARATION_POLICY_INVALID');
    expect(configured.prepare).not.toHaveBeenCalled(); expect(await repository.list()).toHaveLength(1);
});
it('rechecks both write permissions after asynchronous preparation and does not persist through a lost lease', async () => {
    let allowed = true; const writable = createService(async () => allowed), configured = options();
    configured.prepare = async (request, invocation) => {const ready = await prepare(request, invocation); allowed = false; return ready;};
    await expect(writable.prepareTaskCall(input(), configured)).rejects.toHaveProperty('code', 'CALL_READ_ONLY');
    expect(await service.inspectPreparedTaskCall(input())).toBeUndefined(); expect(model).not.toHaveBeenCalled();
});
it('keeps the result when diagnostics fail and never registers the trusted preparation callback as an RPC action', async () => {
    logger.info.mockImplementationOnce(() => {throw Error('Logger unavailable');});
    const ready = await service.prepareTaskCall(input(), options()), bus = new CommandBus(); service.register(bus);
    await expect(bus.execute('session.call.prepare', {plan: ready})).rejects.toThrow();
    expect(await service.inspectPreparedTaskCall(input())).toEqual(ready);
});

it('does not return an uncommitted plan after a write failure and keeps the claim for a later retry', async () => {
    let failed = false;
    interceptWrites(async (session, args) => {
        if (!failed && args[0] === key && (args[1] as any).kernelPreparation?.prepared) {failed = true; throw Object.assign(Error('PRIVATE STORAGE ERROR'), {code: 'EIO'});}
        return session.setShared(...args);
    });
    const seen: string[] = [], configured = options(); configured.prepare = async (request, invocation) => {
        seen.push(invocation.invocationId); return prepare(request, invocation);
    };
    await expect(service.prepareTaskCall(input(), configured)).rejects.toHaveProperty('code', 'EIO');
    expect(await service.inspectPreparedTaskCall(input())).toBeUndefined(); const ready = await service.prepareTaskCall(input(), configured);
    expect(seen).toEqual([ready.invocation.invocationId, ready.invocation.invocationId]); expect(await repository.list()).toHaveLength(2);
    expect(model).not.toHaveBeenCalled(); expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE STORAGE ERROR');
});
it('rejects an unknown record version and a re-sealed target mismatch instead of rebuilding the plan', async () => {
    await service.prepareTaskCall(input(), options()); const owner = await kernel.openSession(parent), original = (await owner.getShared(key))!;
    const bad = structuredClone(original.value) as any; bad.kernelPreparation.version = 99;
    let saved = await owner.setShared(key, bad, {expectedVersion: original.version});
    await expect(service.inspectPreparedTaskCall(input())).rejects.toHaveProperty('code', 'CALL_PREPARATION_CORRUPT');
    const forged = structuredClone(original.value) as any, data = forged.kernelPreparation.prepared;
    data.plan.targetSessionId = parent; data.digest = sha256HexSync(JSON.stringify({plan: data.plan, context: data.context}));
    saved = await owner.setShared(key, forged, {expectedVersion: saved.version});
    await expect(service.inspectPreparedTaskCall(input())).rejects.toHaveProperty('code', 'CALL_PREPARATION_SCOPE_MISMATCH');
    expect(model).not.toHaveBeenCalled();
});
it('assigns a different Invocation and child for an explicit new call rather than reopening the old one', async () => {
    const first = await service.prepareTaskCall(input(), options()), next = input();
    next.request.submission!.id = next.request.submission!.source.id = 'next';
    const second = await service.prepareTaskCall(next, options());
    expect(second.executionSessionId).not.toBe(first.executionSessionId); expect(second.invocation.invocationId).not.toBe(first.invocation.invocationId);
    expect(await repository.list()).toHaveLength(3); expect(submit).not.toHaveBeenCalled();
});

it('keeps the frozen plan when the caller changes its live branch and refuses to rebuild it under new settings', async () => {
    const ready = await service.prepareTaskCall(input(), options()), manifest = await repository.getManifest(parent);
    await repository.updateManifest(parent, {...manifest, branches: {...manifest.branches, other: null}, currentBranch: 'other', currentHead: null});
    const configured = options(); configured.prepare = vi.fn(async () => {throw Error('New settings must not be read');});
    expect(await service.prepareTaskCall(input(), configured)).toEqual(ready); expect(configured.prepare).not.toHaveBeenCalled();
    expect(await repository.list()).toHaveLength(2);
});

it('rejects corrupted caller routing even when the target plan remains intact', async () => {
    await service.prepareTaskCall(input(), options()); const owner = await kernel.openSession(parent), saved = (await owner.getShared(key))!;
    const changed = structuredClone(saved.value) as any; changed.input.request.expectedSessionId = 'foreign';
    await owner.setShared(key, changed, {expectedVersion: saved.version});
    await expect(service.inspectPreparedTaskCall(input())).rejects.toHaveProperty('code', 'CALL_PREPARATION_SCOPE_MISMATCH');
    expect(model).not.toHaveBeenCalled();
});
it.each([undefined, 60_000, null])('replays the original caller submission for deadline policy %s without another target', async timeoutMs => {
    const ready = await service.prepareTaskCall(input(), {...options(), timeoutMs});
    const spec = {program: {kind: 'kernel.call', version: timeoutMs === null ? '2' : '1'}, input: ready.plan,
        requestId: ready.caller.requestId, deferStart: true};
    const first = await kernel.submit(ready.caller.sessionId, spec); await kernel.bindTaskCall({sessionId: ready.caller.sessionId, taskId: first.id}, ready.plan);
    expect((await first.wait({until: 'settled', timeoutMs: 3000})).status).toBe('succeeded');
    const repeated = await createService().prepareTaskCall(input(), {...options(), timeoutMs});
    expect((await kernel.submit(repeated.caller.sessionId, spec)).id).toBe(first.id);
    expect(await kernel.listSessionTasks(ready.executionSessionId)).toHaveLength(1); expect(model).toHaveBeenCalledOnce();
});
it('recovers a lost deferred caller submission reply after restart using the same stored request and plan', async () => {
    const ready = await service.prepareTaskCall(input(), options()), spec = {program: {kind: 'kernel.call', version: '2'}, input: ready.plan,
        requestId: ready.caller.requestId, deferStart: true};
    await expect((async () => {await kernel.submit(ready.caller.sessionId, spec); throw Error('Lost reply');})()).rejects.toThrow('Lost reply');
    const [original] = await kernel.listSessionTasks(parent); expect(original.status).toBe('created'); kernel.dispose(); await kernel.waitIdle();
    kernel = await createKernel(); transfers = new ContentTransferService({kernel, repository, commands: new CommandBus()});
    const current = await createService().inspectPreparedTaskCall(input()); expect(current).toEqual(ready);
    const caller = await kernel.submit(current!.caller.sessionId, spec); expect(caller.id).toBe(original.id);
    await kernel.bindTaskCall({sessionId: parent, taskId: caller.id}, current!.plan);
    expect((await caller.wait({until: 'settled', timeoutMs: 3000})).status).toBe('succeeded'); expect(model).toHaveBeenCalledOnce();
    expect(await kernel.listSessionTasks(current!.executionSessionId)).toHaveLength(1);
});
it('requires a committed plan before trusted dispatch and keeps missing admission read-only', async () => {
    expect(await service.inspectTaskCallSubmission(input())).toBeUndefined();
    await expect(service.submitPreparedTaskCall(input())).rejects.toHaveProperty('code', 'CALL_PREPARATION_REQUIRED');
    expect(await kernel.listSessionTasks(parent)).toEqual([]); expect(submit).not.toHaveBeenCalled();
});
it.each(['chat', 'agent', 'harness'] as const)('submits a persisted %s route through the host API and observes the original caller', async kind => {
    const ready = await service.prepareTaskCall(input(), options(kind)), admitted = await service.submitPreparedTaskCall(input());
    expect(admitted).toMatchObject({operationId: 'call', invocation: ready.invocation, executionSessionId: ready.executionSessionId,
        submission: {requestId: ready.caller.requestId, task: {sessionId: parent}, acceptedAt: expect.any(Number)}});
    const caller = await kernel.attachTask(parent, admitted.submission.task.taskId);
    expect(await caller.wait({until: 'settled', timeoutMs: 3000})).toMatchObject({status: 'succeeded', output: {task: {sessionId: ready.executionSessionId}}});
    expect(await service.inspectTaskCallSubmission(input())).toEqual(admitted);
    expect(await service.submitPreparedTaskCall(input())).toEqual(admitted);
    expect(await kernel.listSessionTasks(parent)).toHaveLength(1); expect(await kernel.listSessionTasks(ready.executionSessionId)).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
});
it('observes actual admission after a lost caller response and resumes that deferred caller without queue fallback', async () => {
    const ready = await service.prepareTaskCall(input(), options()), original = kernel.submit.bind(kernel); let lost = false;
    vi.spyOn(kernel, 'submit').mockImplementation(async (...args) => {const task = await original(...args);
        if (!lost) {lost = true; throw Object.assign(Error('PRIVATE LOST REPLY'), {code: 'ETIMEDOUT'});} return task;});
    await expect(service.submitPreparedTaskCall(input())).rejects.toHaveProperty('code', 'ETIMEDOUT');
    const observed = await service.inspectTaskCallSubmission(input()); expect(observed).toBeDefined();
    expect(await kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
    const resumed = await service.submitPreparedTaskCall(input()); expect(resumed).toEqual(observed);
    const caller = await kernel.attachTask(parent, resumed.submission.task.taskId); await caller.wait({until: 'settled', timeoutMs: 3000});
    expect(model).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE LOST REPLY');
});
it('reconciles a lost binding response without granting or executing again', async () => {
    await service.prepareTaskCall(input(), options()); const original = kernel.bindTaskCall.bind(kernel);
    const bind = vi.spyOn(kernel, 'bindTaskCall').mockImplementation(async (...args) => {await original(...args); throw Error('Binding reply lost');});
    await expect(service.submitPreparedTaskCall(input())).rejects.toThrow('Binding reply lost');
    const receipt = await service.inspectTaskCallSubmission(input()), caller = await kernel.attachTask(parent, receipt!.submission.task.taskId);
    await caller.wait({until: 'settled', timeoutMs: 3000});
    expect(await service.submitPreparedTaskCall(input())).toEqual(receipt); expect(bind).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce();
});
it('cold-reads submitted calls after completion and does not obtain a write lease or create a task', async () => {
    await service.prepareTaskCall(input(), options()); const first = await service.submitPreparedTaskCall(input());
    await (await kernel.attachTask(parent, first.submission.task.taskId)).wait({until: 'settled', timeoutMs: 3000});
    const open = vi.spyOn(kernel, 'openSession'), recover = vi.spyOn(kernel, 'recoverSession'), writable = vi.fn(async () => false);
    expect(await createService(writable).inspectTaskCallSubmission(input())).toEqual(first);
    expect(open).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(writable).not.toHaveBeenCalled();
});
it('observes the same completed submission after Kernel reconstruction without preparation or re-execution', async () => {
    await service.prepareTaskCall(input(), options()); const first = await service.submitPreparedTaskCall(input());
    await (await kernel.attachTask(parent, first.submission.task.taskId)).wait({until: 'settled', timeoutMs: 3000});
    kernel.dispose(); await kernel.waitIdle(); kernel = await createKernel(); transfers = new ContentTransferService({kernel, repository, commands: new CommandBus()});
    const restored = createService(); expect(await restored.inspectTaskCallSubmission(input())).toEqual(first);
    expect(await restored.submitPreparedTaskCall(input())).toEqual(first); expect(model).toHaveBeenCalledOnce();
});
it.each(['source', 'target'] as const)('refuses trusted dispatch when the %s writer is unavailable', async scope => {
    const ready = await service.prepareTaskCall(input(), options());
    const denied = createService(async id => id !== (scope === 'source' ? parent : ready.executionSessionId));
    await expect(denied.submitPreparedTaskCall(input())).rejects.toHaveProperty('code', 'CALL_READ_ONLY');
    expect(await kernel.listSessionTasks(parent)).toEqual([]); expect(model).not.toHaveBeenCalled();
});
it('does not expose prepared dispatch through the legacy RPC registry', async () => {
    await service.prepareTaskCall(input(), options()); const bus = new CommandBus(); service.register(bus);
    await expect(bus.execute('session.call.submit-prepared', input())).rejects.toThrow();
    expect(await kernel.listSessionTasks(parent)).toEqual([]);
});
it('uses the injected host preparer when the caller supplies only frozen policy', async () => {
    const configured = options(), compile = vi.fn(configured.prepare);
    const host = new IndependentCallService({kernel, repository, transfers, submit, hostPorts: {logger}, prepareTaskCall: compile});
    const ready = await host.prepareTaskCall(input(), {maxDepth: 3, timeoutMs: null});
    expect(await host.prepareTaskCall(input(), {maxDepth: 3, timeoutMs: null})).toEqual(ready); expect(compile).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
});
it('does not silently replace an explicitly invalid preparer with the injected host callback', async () => {
    const compile = vi.fn(options().prepare), host = new IndependentCallService({kernel, repository, transfers, submit, prepareTaskCall: compile});
    await expect(host.prepareTaskCall(input(), {maxDepth: 3, prepare: undefined} as never)).rejects.toHaveProperty('code', 'CALL_PREPARATION_UNAVAILABLE');
    expect(compile).not.toHaveBeenCalled(); expect(await kernel.listSessionTasks(parent)).toEqual([]);
});
it('projects a known deferred Kernel admission through the original call query even after a lost reply', async () => {
    const ready = await service.prepareTaskCall(input(), options()), original = kernel.submit.bind(kernel);
    vi.spyOn(kernel, 'submit').mockImplementationOnce(async (...args) => {await original(...args); throw Error('Reply lost');});
    await expect(service.submitPreparedTaskCall(input())).rejects.toThrow('Reply lost');
    const execution = (await service.inspectTaskCallSubmission(input()))!;
    expect(await service.inspect(input())).toMatchObject({status: 'accepted', evidence: 'kernel', callerExecution: execution.submission.task});
    const [view] = await service.list({sessionId: parent});
    expect(view).toMatchObject({historyPending: true, callerState: {id: execution.submission.task.taskId, phase: 'created'}});
    expect(view.receipt.execution).toBeUndefined(); expect(await kernel.listSessionTasks(ready.executionSessionId)).toEqual([]);
});
it('does not confuse a child queue receipt with an unsubmitted Kernel plan', async () => {
    const ready = await service.prepareTaskCall(input(), options()), stored = await (await kernel.inspectSession(parent)).getShared(key);
    const request = (stored!.value as unknown as {childRequest: SubmissionRequest}).childRequest;
    const store = new InstructionQueueStore(kernel), queue = await store.read(ready.executionSessionId);
    const item = prepareInstruction(submissionInstruction(request), ready.executionSessionId, 'main');
    await store.write({...queue, accepted: [{id: item.id, digest: await instructionDigest(item)}]});
    expect(await service.inspect(input())).toMatchObject({status: 'unknown'}); expect(await service.inspectTaskCallSubmission(input())).toBeUndefined();
});
it('shows caller and target facts while execution is in flight without requiring a history message', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
    model.mockImplementationOnce(async () => {await gate; return {choices: [{message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}]};});
    const ready = await service.prepareTaskCall(input(), options()), admitted = await service.submitPreparedTaskCall(input());
    try {await vi.waitFor(async () => {const [view] = await service.list({sessionId: parent});
        expect(view).toMatchObject({historyPending: true, receipt: {evidence: 'kernel', execution: {role: 'primary', invocation: ready.invocation}}, callerState: {id: admitted.submission.task.taskId}});
        expect(view.executionState?.activeOperations).toBe(1); expect(view.status).toBeUndefined();});}
    finally {release();} await (await kernel.attachTask(parent, admitted.submission.task.taskId)).wait({until: 'settled', timeoutMs: 3000});
});
async function completedKernelHistory() {
    const ready = await service.prepareTaskCall(input(), options()), admitted = await service.submitPreparedTaskCall(input());
    await (await kernel.attachTask(parent, admitted.submission.task.taskId)).wait({until: 'settled', timeoutMs: 3000});
    const [view] = await service.list({sessionId: parent}), receipt = view.receipt, execution = {target: {sessionId: receipt.executionSessionId!, taskId: receipt.execution!.taskId}},
        stored = await (await kernel.inspectSession(parent)).getShared(key);
    const request = (stored!.value as unknown as {childRequest: SubmissionRequest}).childRequest;
    const round: import('../src/contracts/conversation').Round = {id: 'call', sessionId: ready.executionSessionId, submission: request.submission,
        submissionDigest: await instructionDigest(prepareInstruction(submissionInstruction(request), ready.executionSessionId, 'main')),
        target: request.expectedTarget, historyParentIds: [], input: [{role: 'user', content: 'PRIVATE INPUT'}], output: [{role: 'assistant', content: 'Confirmed result'}],
        executions: [{taskId: execution.target!.taskId, role: 'primary', invocation: ready.invocation}], status: 'completed', origin: 'user', createdAt: admitted.submission.acceptedAt};
    return {ready, admitted, execution, request, round};
}
it('keeps completed execution separate from failed history commit and does not rerun the target', async () => {
    const {ready, admitted, round} = await completedKernelHistory();
    vi.spyOn(repository, 'updateManifest').mockRejectedValueOnce(Object.assign(Error('PRIVATE WRITE FAILURE'), {code: 'EIO'}));
    await expect(new RoundLog(repository, ready.executionSessionId).append('main', round)).rejects.toHaveProperty('code', 'EIO');
    const [view] = await service.list({sessionId: parent}); expect(view.historyPending).toBe(true); expect(view.status).toBeUndefined(); expect(view.summary).toBeUndefined();
    expect(view.receipt).toMatchObject({status: 'accepted', evidence: 'kernel', execution: {role: 'primary'}});
    expect(await service.submitPreparedTaskCall(input())).toEqual(admitted); expect(model).toHaveBeenCalledOnce();
});
it('uses only indexed history matching the actual Kernel target and original request', async () => {
    const {ready, round} = await completedKernelHistory(); await new RoundLog(repository, ready.executionSessionId).append('main', round);
    const [view] = await service.list({sessionId: parent}); expect(view).toMatchObject({historyPending: false, status: 'completed', summary: 'Confirmed result'});
    expect(view.receipt.evidence).toBe('kernel'); expect(view.receipt.execution?.taskId).toBe(round.executions[0].taskId);
});
it.each(['task', 'invocation', 'digest', 'target'] as const)('rejects unindexed history with a foreign %s instead of trusting its message', async field => {
    const {ready, round} = await completedKernelHistory();
    if (field === 'task') round.executions[0].taskId = 'foreign';
    if (field === 'invocation') round.executions[0].invocation!.invocationId = 'foreign';
    if (field === 'digest') round.submissionDigest = 'foreign';
    if (field === 'target') round.target!.digest = 'foreign';
    await repository.writeDocument(ready.executionSessionId, 'round-call.json', JSON.stringify(round));
    expect(await service.inspect(input())).toMatchObject({status: 'accepted', evidence: 'kernel'});
    await expect(service.list({sessionId: parent})).rejects.toHaveProperty('code', 'CALL_EXECUTION_CONFLICT');
    expect(logger.warn).toHaveBeenCalledWith('Independent call preparation', expect.objectContaining({operation: 'call.execution.observe', stage: 'history', errorCode: 'CALL_EXECUTION_CONFLICT'}));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE INPUT');
});
it('reads original caller and target after reconstruction without writer acquisition or recovery', async () => {
    const {execution} = await completedKernelHistory(); kernel.dispose(); await kernel.waitIdle(); kernel = await createKernel();
    transfers = new ContentTransferService({kernel, repository, commands: new CommandBus()});
    const denied = vi.fn(async () => false), restored = createService(denied), open = vi.spyOn(kernel, 'openSession'), recover = vi.spyOn(kernel, 'recoverSession');
    expect((await restored.inspect(input())).callerExecution?.sessionId).toBe(parent);
    expect((await restored.list({sessionId: parent}))[0].receipt).toMatchObject({status: 'accepted', evidence: 'kernel', execution: {taskId: execution.target!.taskId}});
    expect(denied).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledOnce();
});
it('reports failure as an execution fact even when no history result exists', async () => {
    const manifest = {kind: 'rejected', version: '1'};
    kernel.registerProgram({manifest, init: () => ({state: null, next: {type: 'fail', error: {message: 'Expected failure'}}}), reduce: () => {throw Error('Unexpected');}});
    const configured = options(), original = configured.prepare;
    configured.prepare = async (...args) => {const ready = await original(...args); ready.definition.task.program = manifest; return ready;};
    await service.prepareTaskCall(input(), configured); const admitted = await service.submitPreparedTaskCall(input());
    await (await kernel.attachTask(parent, admitted.submission.task.taskId)).wait({until: 'settled', timeoutMs: 3000});
    const [view] = await service.list({sessionId: parent});
    expect(view).toMatchObject({historyPending: true, callerState: {phase: 'done', exitStatus: 'failed'}, executionState: {phase: 'done', exitStatus: 'failed'}});
    expect(view.status).toBeUndefined(); expect(view.receipt.evidence).toBe('kernel');
});
it('keeps cancellation independent of damaged history when the Kernel target identity is known', async () => {
    const manifest = {kind: 'question', version: '1'};
    kernel.registerProgram({manifest, init: () => ({state: null, actions: [{type: 'request-interaction', interaction: {id: 'question', kind: 'input', prompt: 'Choose', payload: {}}}],
        next: {type: 'wait', on: {type: 'interaction', id: 'question'}}}), reduce: () => {throw Error('Unexpected');}});
    const configured = options(), original = configured.prepare;
    configured.prepare = async (...args) => {const ready = await original(...args); ready.definition.task.program = manifest; return ready;};
    const ready = await service.prepareTaskCall(input(), configured), admitted = await service.submitPreparedTaskCall(input());
    let taskId = '';
    await vi.waitFor(async () => {const [view] = await service.list({sessionId: parent}); taskId = view.receipt.execution?.taskId ?? ''; expect(taskId).not.toBe('');});
    await repository.writeDocument(ready.executionSessionId, 'round-call.json', '{}');
    const commands = new CommandBus(); service.register(commands);
    await commands.execute('session.call.cancel', {sessionId: parent, branchId: 'main', callId: 'call', executionSessionId: ready.executionSessionId,
        taskId, expectedEpoch: 0, requestId: 'stop-without-history'});
    expect((await kernel.task(ready.executionSessionId, taskId)).status).toBe('cancelled');
    expect(await service.inspect(input())).toMatchObject({status: 'accepted', evidence: 'kernel', callerExecution: admitted.submission.task});
});

import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Kernel, type KernelDiagnostic} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend, type IVFSManager} from '@itookit/vfs-core';
import {prepareTaskCall, submitTaskCall, submitPreparedTaskCall, readTaskCallSubmission, readTaskCallExecution, registerDurablePrograms, type TaskRunDefinition, type TaskCallRunOptions} from '../src';

let kernel: Kernel, manager: IVFSManager, diagnostics: KernelDiagnostic[];
const model = vi.fn(async () => ({choices: [{message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}]}));
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); const fs = await manager.openFileSystem('/');
    kernel = new Kernel({catalog: {fs}, maxConcurrentEffects: 1});
    kernel.registerStorageResolver({kind: 'test', resolve: async ref => ({fs, rootPath: String(ref.locator)})});
    registerDurablePrograms(kernel); kernel.registerEffect({kind: 'llm.chat', version: '1', execute: model});
    kernel.registerProgram({manifest: {kind: 'await-signal', version: '1'}, init: () => ({state: null,
        next: {type: 'wait', on: {type: 'signal', id: 'continue'}}}), reduce: () => ({state: null, next: {type: 'complete', output: null}})});
    await kernel.initialize();
    for (const id of ['source', 'target']) await kernel.createSession({id, storage: {kind: 'test', locator: `/${id}`}});
    model.mockClear(); diagnostics = [];
});
afterEach(async () => {vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await manager.dispose();});
function definition(): TaskRunDefinition {
    return {kind: 'task', sessionId: 'target', task: {program: {kind: 'llm.chat', version: '1'}, requestId: 'business-invocation',
        labels: {invocationId: 'callee'}, input: {sessionId: 'target', roundId: 'round', connectionId: 'model',
            messages: [{role: 'user', content: 'Hello'}]}}, capabilities: [
        {kind: 'llm', uri: 'llm://model', rights: ['execute'], signalKey: 'llmHandleId'}]};
}
function options(requestId = 'call'): TaskCallRunOptions {
    return {kernel, caller: {sessionId: 'source', requestId}, maxDepth: 3, onDiagnostic: event => diagnostics.push(event)};
}
it('prepares a detached plan without executing and submits the actual structured output through the Kernel', async () => {
    const compiled = definition(), plan = prepareTaskCall(compiled, {maxDepth: 3});
    expect(plan.task).not.toHaveProperty('requestId'); expect(plan.task.labels).toEqual({invocationId: 'callee'});
    expect(compiled.task.requestId).toBe('business-invocation'); expect(model).not.toHaveBeenCalled();
    expect(await kernel.listSessionTasks('target')).toEqual([]);
    compiled.task.labels!.invocationId = 'changed'; expect(plan.task.labels).toEqual({invocationId: 'callee'});
    const run = await submitTaskCall(definition(), options());
    expect(await run.root.wait({until: 'settled', timeoutMs: 3000})).toMatchObject({status: 'succeeded',
        output: {task: {sessionId: 'target'}, exit: {output: {message: {content: 'Done'}}}}});
    expect(run.tasks()).toEqual([run.root]); expect(model).toHaveBeenCalledOnce();
    expect((await kernel.listSessionTasks('target'))[0].ownedBy).toMatchObject({sessionId: 'source', taskId: run.root.id});
});
it('replays the same completed source call without rebinding capabilities or creating another target', async () => {
    const first = await submitTaskCall(definition(), options()); await first.root.wait({timeoutMs: 3000});
    const bind = vi.spyOn(kernel, 'bindTaskCall'); const second = await submitTaskCall(definition(), options());
    expect(second.root.id).toBe(first.root.id); expect(bind).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledOnce();
    expect(await kernel.listSessionTasks('target')).toHaveLength(1);
    const changed = definition(); changed.task.input = {messages: [{role: 'user', content: 'Changed'}]};
    await expect(submitTaskCall(changed, options())).rejects.toHaveProperty('code', 'CONFLICT');
});
it('rehydrates the frozen definition and rejects rebuilding it with a different representation under the same request', async () => {
    const compiled = definition(), first = await submitTaskCall(compiled, options()); await first.root.wait({timeoutMs: 3000});
    expect((await submitTaskCall(JSON.parse(JSON.stringify(compiled)), options())).root.id).toBe(first.root.id);
    const input = compiled.task.input as Record<string, unknown>; compiled.task.input = Object.fromEntries(Object.entries(input).reverse());
    await expect(submitTaskCall(compiled, options())).rejects.toHaveProperty('code', 'CONFLICT');
    expect(model).toHaveBeenCalledOnce(); expect(await kernel.listSessionTasks('target')).toHaveLength(1);
});
it('recovers a lost caller submission reply without creating another source or target', async () => {
    const submit = kernel.submit.bind(kernel); let lose = true;
    vi.spyOn(kernel, 'submit').mockImplementation(async (...args) => {
        const task = await submit(...args); if (args[0] === 'source' && lose) {lose = false; throw Error('Reply lost');} return task;
    });
    await expect(submitTaskCall(definition(), options())).rejects.toThrow('Reply lost');
    expect(await kernel.listSessionTasks('target')).toEqual([]);
    const run = await submitTaskCall(definition(), options()); expect((await run.root.wait({timeoutMs: 3000})).status).toBe('succeeded');
    expect(await kernel.listSessionTasks('source')).toHaveLength(1); expect(await kernel.listSessionTasks('target')).toHaveLength(1);
});
it('recovers a lost capability binding reply from the original call and never re-executes its target', async () => {
    const bind = kernel.bindTaskCall.bind(kernel), spy = vi.spyOn(kernel, 'bindTaskCall').mockImplementation(async (...args) => {
        await bind(...args); throw Error('Binding reply lost');
    });
    await expect(submitTaskCall(definition(), options())).rejects.toThrow('Binding reply lost');
    await vi.waitFor(async () => expect((await kernel.listSessionTasks('source'))[0].status).toBe('succeeded'));
    spy.mockRestore(); const replay = await submitTaskCall(definition(), options());
    expect((await replay.root.wait()).status).toBe('succeeded'); expect(model).toHaveBeenCalledOnce();
    expect(await kernel.listSessionTasks('target')).toHaveLength(1);
});
it('keeps the source call inside its real parent control tree and leaves unrelated target Tasks alone', async () => {
    const parent = await kernel.submit('source', {program: {kind: 'await-signal', version: '1'}, input: null});
    const unrelated = await kernel.submit('target', {program: {kind: 'await-signal', version: '1'}, input: null});
    const compiled = definition(); compiled.task.program = {kind: 'await-signal', version: '1'};
    const configured = options(); configured.caller.parent = parent.id; configured.caller.spawnKey = 'worker';
    const call = await submitTaskCall(compiled, configured);
    await vi.waitFor(async () => expect(await kernel.listSessionTasks('target')).toHaveLength(2));
    await parent.cancel(); expect((await call.root.status()).task.status).toBe('cancelled');
    const owned = (await kernel.listSessionTasks('target')).find(task => task.ownedBy)!;
    expect(owned.status).toBe('cancelled'); expect((await unrelated.status()).task.exit).toBeUndefined();
});
it.each(['parent', 'spawnKey'] as const)('rejects a target %s before admitting either side', async field => {
    const compiled = definition(); compiled.task[field] = 'foreign';
    await expect(submitTaskCall(compiled, options())).rejects.toHaveProperty('code', 'INVALID_SPEC');
    expect(await kernel.listSessionTasks('source')).toEqual([]); expect(await kernel.listSessionTasks('target')).toEqual([]);
});
it.each([0, NaN, Infinity])('rejects invalid depth %s before creating a source invocation', async maxDepth => {
    await expect(submitTaskCall(definition(), {...options(), maxDepth})).rejects.toHaveProperty('code', 'INVALID_SPEC');
    expect(await kernel.listSessionTasks('source')).toEqual([]);
});
it('rejects graph preparation and malformed caller identity without opening a Session', async () => {
    const open = vi.spyOn(kernel, 'openSession');
    await expect(submitTaskCall({kind: 'graph'} as never, options())).rejects.toHaveProperty('code', 'INVALID_SPEC');
    const configured = options(); configured.caller.requestId = ' ';
    await expect(submitTaskCall(definition(), configured)).rejects.toHaveProperty('code', 'INVALID_SPEC');
    expect(open).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
});
it('reports the original failure stage without input and preserves the result when diagnostics throw', async () => {
    const configured = options(), compiled = definition(); compiled.task.input = 'PRIVATE INPUT';
    compiled.task.parent = 'forbidden';
    await expect(submitTaskCall(compiled, configured)).rejects.toHaveProperty('code', 'INVALID_SPEC');
    expect(diagnostics[0]).toMatchObject({operation: 'run.task.call', stage: 'plan', errorCode: 'INVALID_SPEC', operationId: 'call'});
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE INPUT');
    configured.onDiagnostic = () => {throw Error('Logger failed');};
    const run = await submitTaskCall(definition(), configured); expect((await run.root.wait({timeoutMs: 3000})).status).toBe('succeeded');
});

it('omits malformed identity data from diagnostics instead of logging it as an operation ID', async () => {
    const configured = options(); configured.caller.requestId = {secret: 'PRIVATE BODY'} as never;
    await expect(submitTaskCall(definition(), configured)).rejects.toHaveProperty('code', 'INVALID_SPEC');
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE BODY'); expect(diagnostics[0].operationId).toBe('unidentified-task-call');
    expect(await kernel.listSessionTasks('source')).toEqual([]);
});

it.each([undefined, 60_000, null])('freezes deadline policy %s without changing prior source identities', async timeoutMs => {
    const configured = {...options(), timeoutMs}, first = await submitTaskCall(definition(), configured);
    expect((await first.root.wait({timeoutMs: 3000})).status).toBe('succeeded');
    const record = (await first.root.status()).task;
    expect(record.program.version).toBe(timeoutMs === null ? '2' : '1');
    expect(record.effects.call.request.timeoutMs).toBe(timeoutMs === undefined ? 30_000 : timeoutMs);
    expect(record.effects.call.deadlineAt === undefined).toBe(timeoutMs === null);
    expect((await submitTaskCall(definition(), configured)).root.id).toBe(first.root.id);
    expect(model).toHaveBeenCalledOnce();
    const alternate = {...configured, timeoutMs: timeoutMs === null ? 60_000 : null};
    await expect(submitTaskCall(definition(), alternate)).rejects.toHaveProperty('code', 'CONFLICT');
});

it('submits and cold-observes a stored plan without opening another writer or rebuilding its policy', async () => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3, timeoutMs: null}), configured = options();
    const parameters = {kernel, caller: configured.caller, onDiagnostic: configured.onDiagnostic};
    expect(await readTaskCallSubmission(plan, parameters)).toBeUndefined();
    const run = await submitPreparedTaskCall(plan, parameters); await run.root.wait({until: 'settled', timeoutMs: 3000});
    const open = vi.spyOn(kernel, 'openSession'), recover = vi.spyOn(kernel, 'recoverSession');
    expect(await readTaskCallSubmission(plan, parameters)).toMatchObject({requestId: 'call', task: {sessionId: 'source', taskId: run.root.id}});
    expect(open).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
    expect((await submitPreparedTaskCall(plan, parameters)).root.id).toBe(run.root.id); expect(model).toHaveBeenCalledOnce();
});
it('reconciles a lost prepared submission response before retrying the same caller', async () => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3}), configured = {kernel, caller: options().caller};
    const submit = kernel.submit.bind(kernel); let lose = true;
    vi.spyOn(kernel, 'submit').mockImplementation(async (...args) => {const task = await submit(...args);
        if (lose) {lose = false; throw Error('Reply lost');} return task;});
    await expect(submitPreparedTaskCall(plan, configured)).rejects.toThrow('Reply lost');
    const receipt = await readTaskCallSubmission(plan, configured); expect(receipt).toBeDefined(); expect(await kernel.listSessionTasks('target')).toEqual([]);
    const replay = await submitPreparedTaskCall(plan, configured); expect(replay.root.id).toBe(receipt!.task.taskId);
    expect((await replay.root.wait({timeoutMs: 3000})).status).toBe('succeeded'); expect(model).toHaveBeenCalledOnce();
});
it.each(['maxDepth', 'timeoutMs'] as const)('rejects a new %s override on a frozen plan before source admission', async key => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3}), configured = {kernel, caller: options().caller, [key]: 9};
    await expect(submitPreparedTaskCall(plan, configured)).rejects.toHaveProperty('code', 'INVALID_SPEC');
    await expect(readTaskCallSubmission(plan, configured)).rejects.toHaveProperty('code', 'INVALID_SPEC');
    expect(await kernel.listSessionTasks('source')).toEqual([]);
});
it('keeps an exact-spec conflict distinct from a missing submission', async () => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3}), configured = {kernel, caller: options().caller};
    const run = await submitPreparedTaskCall(plan, configured); await run.root.wait({timeoutMs: 3000});
    const changed = structuredClone(plan); changed.task.input = 'PRIVATE CONTENT';
    await expect(readTaskCallSubmission(changed, configured)).rejects.toHaveProperty('code', 'CONFLICT'); expect(model).toHaveBeenCalledOnce();
});
it('reads the original caller and owned target independently of UI history', async () => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3, timeoutMs: null}), configured = {kernel, caller: options().caller};
    expect(await readTaskCallExecution(plan, configured)).toBeUndefined();
    const run = await submitPreparedTaskCall(plan, configured), exit = await run.root.wait({until: 'settled', timeoutMs: 3000});
    expect(await readTaskCallExecution(plan, configured)).toMatchObject({submission: {task: {sessionId: 'source', taskId: run.root.id}}, target: exit.output!.task});
    expect(model).toHaveBeenCalledOnce();
});
it('rejects a target that does not belong to the frozen plan', async () => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3}), configured = {kernel, caller: options().caller};
    const run = await submitPreparedTaskCall(plan, configured); await run.root.wait({until: 'settled', timeoutMs: 3000});
    vi.spyOn(kernel, 'readTaskCallTarget').mockResolvedValue({sessionId: 'foreign', taskId: 'foreign'});
    await expect(readTaskCallExecution(plan, configured)).rejects.toHaveProperty('code', 'TASK_CALL_TARGET_INVALID');
});
it('uses the admitted caller identity if the request object changes during inspection', async () => {
    const plan = prepareTaskCall(definition(), {maxDepth: 3}), configured = {kernel, caller: options().caller};
    const run = await submitPreparedTaskCall(plan, configured); await run.root.wait({until: 'settled', timeoutMs: 3000});
    const original = kernel.readTaskSubmissionReceipt.bind(kernel); let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    vi.spyOn(kernel, 'readTaskSubmissionReceipt').mockImplementationOnce(async (...args) => {const receipt = await original(...args); await gate; return receipt;});
    const pending = readTaskCallExecution(plan, configured); configured.caller.sessionId = 'foreign'; release();
    expect(await pending).toMatchObject({submission: {task: {sessionId: 'source'}}, target: {sessionId: 'target'}});
});

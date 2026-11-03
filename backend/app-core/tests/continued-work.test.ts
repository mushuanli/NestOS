import {expect, it, vi, afterEach} from 'vitest';
import {withContinuedWork} from '../src/kanban/continued-work';
import {sessionSubmission} from '../src/run/session-submission';
const context = vi.hoisted(() => ({bindings: {} as Record<string, unknown>}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: context.bindings}})}));
afterEach(() => {context.bindings = {};});
function fixture() {
    const primary = {prepare: vi.fn(), start: vi.fn(), inspect: vi.fn()};
    const original = {schema: 1, dispatch: {id: 'original', itemId: 'item'}, input: {title: 'Work', request: {expectedSessionId: 'caller', expectedBranch: 'main',
        expectedTarget: {kind: 'agent', id: 'worker', version: '1', digest: 'digest'}, submission: {id: 'original'}}}};
    const submission = {start: vi.fn(async () => ({sessionId: 'original-execution', outcome: 'running' as const})),
        inspect: vi.fn(async () => ({sessionId: 'original-execution', outcome: 'running' as const}))};
    const options = {submission, calls: {inspectTaskCallSubmission: vi.fn(async () => ({executionSessionId: 'original-execution'})),
        list: vi.fn(async () => [{callerState: {settled: true}, executionTree: {settled: true}}])}, kernel: {sessionActivity: vi.fn(async () => ({counts: {running: 0}}))},
        prepare: vi.fn(async () => 'Frozen continuation instruction'), observe: vi.fn(async (_dispatch, result) => result)} as any;
    const dispatch = {id: 'continuation', itemId: 'item', continuation: {previousDispatchId: 'original'}}, item = {id: 'item'};
    return {primary, original, submission, options, dispatch, item, executor: withContinuedWork(primary as any, options)};
}
it('continues the original execution Session with explicit context selection and a fresh stable submission', async () => {
    const f = fixture(); context.bindings = {binding: {id: 'binding', branchId: 'main', validity: 'valid', revision: 3, generation: 1}};
    const frozen = await f.executor.prepareContinuation!(f.dispatch as any, f.item as any, f.original) as any;
    expect(frozen.request).toMatchObject({expectedSessionId: 'original-execution', submission: {id: 'continuation'},
        overrides: {harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 3}}});
    expect(await f.executor.start(frozen)).toMatchObject({executionSessionId: 'original-execution', outcome: 'running'});
    const recovered = withContinuedWork(f.primary as any, f.options); await recovered.inspect(JSON.parse(JSON.stringify(frozen)));
    expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.submission.inspect).toHaveBeenCalledOnce();
    expect(f.primary.start).not.toHaveBeenCalled(); expect(f.options.observe).toHaveBeenCalledTimes(2);
    const next = await recovered.prepareContinuation!({...f.dispatch, id: 'next'} as any, f.item as any, frozen) as any;
    expect(next.origin).toEqual(f.original); expect(next.request.expectedSessionId).toBe('original-execution');
});
it('refuses busy or invalid original bindings before preparing new workspace files', async () => {
    const f = fixture(); context.bindings = {binding: {branchId: 'main', validity: 'invalid'}};
    await expect(f.executor.prepareContinuation!(f.dispatch as any, f.item as any, f.original)).rejects.toMatchObject({code: 'CONTINUATION_CONTEXT_AMBIGUOUS'});
    expect(f.options.prepare).not.toHaveBeenCalled();
    context.bindings = {}; f.options.kernel.sessionActivity.mockResolvedValue({counts: {running: 1}});
    await expect(f.executor.prepareContinuation!(f.dispatch as any, f.item as any, f.original)).rejects.toMatchObject({code: 'CONTINUATION_IN_USE'});
    expect(f.submission.start).not.toHaveBeenCalled();
});
it('uses ordinary Session admission and withholds success until the full execution tree settles', async () => {
    const request = {expectedSessionId: 'same', expectedBranch: 'main', submission: {id: 'new', source: {kind: 'conversation', ownerId: 'same', id: 'new'}}} as any;
    const root = {id: 'task', sessionId: 'same', rootTaskId: 'task', labels: {roundId: 'new'}, effects: {}, exit: {status: 'succeeded'}};
    const child = {id: 'child', rootTaskId: 'task', effects: {external: {status: 'leased'}}, exit: {status: 'succeeded'}};
    const round = {id: 'new', sessionId: 'same', submission: request.submission, status: 'completed', executions: [{role: 'primary', taskId: 'task'}]};
    const lease = {commandBus: {execute: vi.fn()}, dispose: vi.fn()}, open = vi.fn(async () => lease);
    const snapshot = {tasks: [root, child]}, options = {contexts: {open}, repository: {readDocument: async () => JSON.stringify(round)},
        kernel: {task: async () => root, inspectSession: async () => ({snapshot: async () => snapshot})}} as any;
    const port = sessionSubmission(options); expect(await port.start(request)).toMatchObject({sessionId: 'same', outcome: 'running'});
    expect(open).toHaveBeenCalledWith('same'); expect(lease.commandBus.execute).toHaveBeenCalledWith('session.submit', request);
    child.effects = {} as any;
    expect(await port.inspect(request)).toMatchObject({outcome: 'succeeded'}); expect(open).toHaveBeenCalledOnce();
    round.submission = {...request.submission, id: 'wrong'};
    await expect(port.inspect(request)).rejects.toMatchObject({code: 'SUBMISSION_HISTORY_CONFLICT'});
});
it('distinguishes a confirmed writer rejection from an uncertain submitted request', async () => {
    const request = {expectedSessionId: 'same', expectedBranch: 'main', submission: {id: 'new'}} as any;
    const open = vi.fn(), options = {contexts: {open}, ensureWritable: async () => false} as any;
    await expect(sessionSubmission(options).start(request)).rejects.toMatchObject({code: 'SESSION_WRITER_UNAVAILABLE', executionOutcome: 'not-started', retryable: true});
    expect(open).not.toHaveBeenCalled();
    const lease = {commandBus: {execute: vi.fn(async () => {throw Object.assign(new Error('transport'), {code: 'EIO'});})}, dispose: vi.fn()};
    options.ensureWritable = async () => true; open.mockResolvedValue(lease);
    const error = await sessionSubmission(options).start(request).catch(error => error);
    expect(error.code).toBe('EIO'); expect(error.executionOutcome).toBeUndefined(); expect(lease.dispose).toHaveBeenCalledOnce();
});
it('retries recovery of the original Session on observation after a boot-time lease refusal without submitting input', async () => {
    const recover = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), read = vi.fn(async () => null), open = vi.fn();
    const port = sessionSubmission({contexts: {open}, repository: {readDocument: read}, ensureWritable: recover} as any);
    const request = {expectedSessionId: 'original', submission: {id: 'frozen'}} as any;
    expect(await port.inspect(request)).toMatchObject({outcome: 'unknown', code: 'SESSION_WRITER_UNAVAILABLE'});
    expect(read).not.toHaveBeenCalled();
    expect(await port.inspect(request)).toMatchObject({outcome: 'unknown', code: 'SUBMISSION_RECEIPT_UNKNOWN'});
    expect(recover).toHaveBeenNthCalledWith(2, 'original'); expect(open).not.toHaveBeenCalled();
});
it('reattaches a host execution context to a running admitted round without submitting it again', async () => {
    const request = {expectedSessionId: 'original', submission: {id: 'frozen', source: {kind: 'conversation', ownerId: 'original', id: 'frozen'}}} as any;
    const round = {id: 'frozen', sessionId: 'original', submission: request.submission, status: 'running', executions: [{role: 'primary', taskId: 'task'}]};
    const task = {id: 'task', rootTaskId: 'task', labels: {roundId: 'frozen'}, effects: {native: {status: 'leased'}}};
    const execute = vi.fn(), lease = {commandBus: {execute}, dispose: vi.fn()}, open = vi.fn(async () => lease);
    const port = sessionSubmission({contexts: {open}, ensureWritable: async () => true, repository: {readDocument: async () => JSON.stringify(round)},
        kernel: {task: async () => task, inspectSession: async () => ({snapshot: async () => ({tasks: [task]})})}} as any);
    expect(await port.inspect(request)).toMatchObject({outcome: 'running'});
    expect(open).toHaveBeenCalledWith('original'); expect(lease.dispose).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
});

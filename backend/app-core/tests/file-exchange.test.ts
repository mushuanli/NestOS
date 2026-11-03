import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {advanceFileExchange, type FileExchangeOptions} from '../src/run/file-exchange';
import {initializeFileExchange, fileRequestDigest, type FileRequest} from '../src/run/file-exchange-protocol';
import {consumeWorkspaceMessages} from '../src/run/workspace-messages';
import {readPrompt} from '../src/run/prompt-bundle';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const journal = new KanbanAutomationJournal(fs); await journal.open(); const directory = '/work/_nestos/kanban';
    await initializeFileExchange(fs, directory, 'operation');
    const request: FileRequest = {schema: 'work-message/2', id: 'question', type: 'request', scopeId: 'operation', method: 'kanban.context.resolve', waitForResponse: true, params: {repository: '.', commits: ['a'.repeat(40)]}};
    const publish = async (value = request) => fs.driver.createFile({parentPath: directory + '/inbox', name: value.id + '.yaml', content: JSON.stringify(value)});
    let outcome: 'running' | 'succeeded' | 'cancelled' = 'running';
    const submission = {start: vi.fn(async (_request: SubmissionRequest) => ({sessionId: 'original', outcome})), inspect: vi.fn(async (_request: SubmissionRequest) => ({sessionId: 'original', outcome}))};
    const prepare = vi.fn(async (id: string) => ({expectedSessionId: 'original', expectedBranch: 'main', submission: {id, source: {kind: 'conversation', ownerId: 'original', id}}}) as SubmissionRequest);
    const resolve = vi.fn(async () => ({contexts: [{task: 'prior-task', revision: 1}]})); const report = vi.fn(async () => {});
    const options = {id: 'operation', scopeId: 'operation', directory, fs, journal, submission, prepare, resolve, report} as FileExchangeOptions;
    const initial = {sessionId: 'original', outcome: 'succeeded' as const};
    return {fs, journal, directory, request, options, publish, submission, prepare, resolve, report, initial, complete: () => {outcome = 'succeeded';}, cancel: () => {outcome = 'cancelled';}};
}
it('waits for the native turn to end, publishes a response and resumes only the original Session', async () => {
    const f = await fixture(); await f.publish();
    expect(await advanceFileExchange(f.options, {...f.initial, outcome: 'running'})).toMatchObject({outcome: 'running'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submission.start).not.toHaveBeenCalled(); expect(await f.fs.driver.exists(f.directory + '/outbox/question.yaml')).toBe(false);
    expect(await advanceFileExchange(f.options, f.initial)).toMatchObject({outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'});
    const response = JSON.parse(await readPrompt(f.fs, f.directory + '/outbox/question.yaml'));
    expect(response).toMatchObject({schema: 'work-message/2', replyTo: 'question', scopeId: 'operation', requestDigest: fileRequestDigest(f.request), status: 'ok'});
    expect(f.prepare).toHaveBeenCalledWith(expect.any(String), [{path: f.directory + '/outbox/question.yaml', sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}]);
    expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original'}));
    f.complete(); expect(await advanceFileExchange(f.options, f.initial)).toMatchObject({outcome: 'succeeded'});
    await advanceFileExchange(f.options, f.initial); expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
});
it('survives a lost submission reply and a new coordinator instance without replaying the turn', async () => {
    const f = await fixture(); await f.publish();
    f.submission.start.mockRejectedValueOnce(Object.assign(new Error('Lost reply'), {code: 'TRANSPORT_DISCONNECTED'}));
    expect(await advanceFileExchange(f.options, f.initial)).toMatchObject({outcome: 'unknown'});
    const restored = {...f.options, journal: new KanbanAutomationJournal(f.fs)};
    expect(await advanceFileExchange(restored, f.initial)).toMatchObject({outcome: 'running'});
    f.complete(); await advanceFileExchange(restored, f.initial);
    expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
});
it('keeps the frozen response when Cells disconnects during publication and resumes after reconnect', async () => {
    const f = await fixture(); await f.publish(); const rename = vi.spyOn(f.fs.driver, 'rename').mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'ECONNRESET'}));
    await expect(advanceFileExchange(f.options, f.initial)).rejects.toMatchObject({code: 'ECONNRESET'});
    expect(f.submission.start).not.toHaveBeenCalled(); rename.mockRestore();
    await advanceFileExchange({...f.options, journal: new KanbanAutomationJournal(f.fs)}, f.initial);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('rejects changed requests, wrong scopes and changed response files', async () => {
    const f = await fixture(); await f.publish(); await advanceFileExchange(f.options, f.initial);
    await f.fs.driver.writeContent(f.directory + '/inbox/question.yaml', JSON.stringify({...f.request, params: {commits: []}}));
    await expect(advanceFileExchange(f.options, f.initial)).rejects.toMatchObject({code: 'FILE_EXCHANGE_REQUEST_CHANGED'});
    await f.fs.driver.writeContent(f.directory + '/inbox/question.yaml', JSON.stringify({...f.request, scopeId: 'other'}));
    await expect(advanceFileExchange(f.options, f.initial)).rejects.toMatchObject({code: 'FILE_EXCHANGE_SCOPE_INVALID'});
    await f.fs.driver.writeContent(f.directory + '/inbox/question.yaml', JSON.stringify(f.request)); await f.fs.driver.writeContent(f.directory + '/outbox/question.yaml', '{}');
    await expect(advanceFileExchange(f.options, f.initial)).rejects.toMatchObject({code: 'FILE_EXCHANGE_RESPONSE_CHANGED'});
    expect(f.submission.start).toHaveBeenCalledOnce();
});
it('returns explicit application errors in immutable response files and never converts transport errors to answers', async () => {
    const f = await fixture(); await f.publish(); f.resolve.mockRejectedValueOnce(Object.assign(new Error('unsupported'), {code: 'FILE_EXCHANGE_METHOD_UNSUPPORTED', fileResponse: true}));
    await advanceFileExchange(f.options, f.initial);
    expect(JSON.parse(await readPrompt(f.fs, f.directory + '/outbox/question.yaml'))).toMatchObject({status: 'error', error: {code: 'FILE_EXCHANGE_METHOD_UNSUPPORTED'}});
    f.complete(); await advanceFileExchange(f.options, f.initial); await f.publish({...f.request, id: 'second'});
    f.resolve.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'ECONNRESET'}));
    await expect(advanceFileExchange(f.options, f.initial)).rejects.toMatchObject({code: 'ECONNRESET'});
    expect(await f.fs.driver.exists(f.directory + '/outbox/second.yaml')).toBe(false); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('supports batches and a second question using new rounds in the same Session', async () => {
    const f = await fixture(); await f.publish(); await f.publish({...f.request, id: 'parallel'});
    await advanceFileExchange(f.options, f.initial); expect(f.prepare.mock.calls[0][1]).toHaveLength(2);
    f.complete(); await advanceFileExchange(f.options, f.initial); await f.publish({...f.request, id: 'later'}); await advanceFileExchange(f.options, f.initial);
    expect(f.submission.start).toHaveBeenCalledTimes(2); expect(new Set(f.submission.start.mock.calls.map(([row]) => row.expectedSessionId))).toEqual(new Set(['original']));
    expect(f.submission.start.mock.calls[0][0].submission!.id).not.toBe(f.submission.start.mock.calls[1][0].submission!.id);
});
it('does not resume a failed or cancelled native turn and preserves legacy messages', async () => {
    const f = await fixture(); await f.publish(); expect(await advanceFileExchange(f.options, {...f.initial, outcome: 'cancelled'})).toMatchObject({outcome: 'cancelled'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submission.start).not.toHaveBeenCalled();
    const scope = {runId: 'run', itemId: 'task', attemptId: 'operation'};
    await f.fs.driver.createFile({parentPath: f.directory + '/inbox', name: 'progress.json', content: JSON.stringify({schema: 'work-message/1', id: 'progress', type: 'progress', content: 'Progress', ...scope})});
    const deliver = vi.fn(async () => {}); const messages = await consumeWorkspaceMessages(f.fs, f.directory, scope, f.journal, deliver);
    expect(messages).toHaveLength(1); expect(deliver).toHaveBeenCalledOnce();
});
it('only retries a proved pre-admission ownership rejection, retaining the frozen identity', async () => {
    const f = await fixture(); await f.publish(); f.submission.start.mockRejectedValueOnce(Object.assign(new Error('Read only'), {executionOutcome: 'not-started', retryable: true, code: 'SESSION_WRITER_UNAVAILABLE'}));
    await advanceFileExchange(f.options, f.initial); await advanceFileExchange(f.options, f.initial);
    expect(f.submission.start).toHaveBeenCalledTimes(2); expect(f.submission.start.mock.calls[0][0]).toEqual(f.submission.start.mock.calls[1][0]);
});
it('refuses to resume when a final result and a new request are published together', async () => {
    const f = await fixture(); await f.publish();
    await expect(advanceFileExchange({...f.options, finalPublished: true}, f.initial)).rejects.toMatchObject({code: 'FILE_EXCHANGE_RESULT_CONFLICT'});
    expect(f.submission.start).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
});
it('recovers a prepared continuation after the coordinator stops before submission', async () => {
    const f = await fixture(); await f.publish();
    f.report.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {throw new Error('Coordinator stopped');});
    await expect(advanceFileExchange(f.options, f.initial)).rejects.toThrow('Coordinator stopped');
    const saved = await f.journal.get<{phase: string; request: SubmissionRequest}>('file-exchange:operation');
    expect(saved!.phase).toBe('prepared'); expect(f.submission.start).not.toHaveBeenCalled();
    await advanceFileExchange({...f.options, journal: new KanbanAutomationJournal(f.fs)}, f.initial);
    expect(f.submission.start).toHaveBeenCalledWith(saved!.request); expect(f.resolve).toHaveBeenCalledOnce();
});
it('publishes a bounded error response for oversized answers without leaking arbitrary error text', async () => {
    const f = await fixture(); await f.publish(); f.resolve.mockResolvedValueOnce({contexts: ['x'.repeat(70000)]} as never);
    await advanceFileExchange(f.options, f.initial);
    expect(JSON.parse(await readPrompt(f.fs, f.directory + '/outbox/question.yaml'))).toMatchObject({status: 'error', error: {code: 'FILE_EXCHANGE_RESPONSE_LIMIT'}});
    f.complete(); await advanceFileExchange(f.options, f.initial); await f.publish({...f.request, id: 'next'});
    f.resolve.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {fileResponse: true, code: 'PRIVATE_BODY token=secret'}));
    await advanceFileExchange(f.options, f.initial);
    const text = await readPrompt(f.fs, f.directory + '/outbox/next.yaml'); expect(text).not.toContain('PRIVATE_BODY'); expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({error: {code: 'FILE_EXCHANGE_RESOLUTION_FAILED'}});
});
it('rechecks the mailbox before reporting success even when the continuation finishes immediately', async () => {
    const f = await fixture(); await f.publish(); f.complete();
    expect(await advanceFileExchange(f.options, f.initial)).toMatchObject({outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'});
    expect(await advanceFileExchange(f.options, f.initial)).toMatchObject({outcome: 'succeeded'}); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('rereads files after settlement and catches a final result published alongside a late request', async () => {
    const f = await fixture(); await f.publish(); await advanceFileExchange(f.options, f.initial); let final = false;
    f.submission.inspect.mockImplementationOnce(async () => {await f.publish({...f.request, id: 'late'}); final = true; return {sessionId: 'original', outcome: 'succeeded'};});
    await expect(advanceFileExchange({...f.options, finalPublished: async () => final}, f.initial)).rejects.toMatchObject({code: 'FILE_EXCHANGE_RESULT_CONFLICT'});
    expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
});

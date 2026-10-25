import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {SessionCommand, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {SendMessageCommand} from './SendMessageCommand';
import type {CommandContext} from './CommandContext';
import type {IChatInputConfig} from '../domain/ports/IChatInputPresenter';
import {Toast} from '@itookit/ui-common';

const target = {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'};
const context = () => ({revision: 1, sessionId: 'session', branchId: 'main', target: {...target}, selection: {
    mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1, checkpointRef: 'checkpoint-A'}});
function latch<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function fixture() {
    let config: IChatInputConfig = {text: 'Original', agentId: 'worker', target, context: context(), settings: {}}, session = 'session', branch = 'main';
    const files: File[] = [], operations = createOperationLedger(), accept = vi.fn();
    const commands = {execute: vi.fn(async (name, request) => name === SessionCommand.Submit ? request.submission.id : {items: []})};
    const chatInput = {getConfig: () => structuredClone(config), getDraftRevision: () => 1, getDraftFiles: () => [...files],
        acceptSubmittedDraft: accept, setLoading() {}, setConfig: (patch: Partial<IChatInputConfig>) => {config = {...config, ...patch};}, restoreInput() {}};
    const ctx = {chatInput, operations, commands, getSessionId: () => session, getBranch: () => branch, observeInstructions: () => () => {},
        reconcileSubmission: vi.fn(async () => ({operationId: 'call', status: 'accepted'})), errorHandler: {wrap: (work: () => Promise<unknown>) => work()},
        historyView: {scrollToBottom() {}, setSubmission() {}}, isGenerating: () => false} as unknown as CommandContext;
    return {ctx, command: new SendMessageCommand(ctx), config: () => config, change: (patch: Partial<IChatInputConfig>) => {config = {...config, ...patch};},
        scope: (nextSession: string, nextBranch: string) => {session = nextSession; branch = nextBranch;}, files, operations, commands, accept};
}
async function originalOperation(f: ReturnType<typeof fixture>, evidence: unknown = context(), includeEvidence = true) {
    const request: SubmissionRequest = {target, expectedTarget: target, expectedSessionId: 'session', expectedBranch: 'main',
        source: {kind: 'composer', text: 'Original', attachments: [], values: {}}, overrides: {harnessConversation: context().selection},
        submission: {id: 'call', source: {kind: 'conversation', ownerId: 'session', id: 'call'}}};
    await f.operations.register({context: {viewId: 'session', operationId: 'call'}, conversationId: 'session', kind: 'send', status: 'unknown',
        input: JSON.parse(JSON.stringify({request, ...(includeEvidence ? {contextDraft: evidence} : {})}))});
}

it('freezes a selection before asynchronous submission preparation and stores its draft evidence outside request', async () => {
    const f = fixture(), held = latch<NonNullable<SubmissionRequest['submission']>>(), entered = latch<void>(), selected = context().selection;
    f.ctx.resolveSubmission = async () => {entered.resolve(); return held.promise;};
    const sending = f.command.run({text: 'Original', files: [], agentId: 'worker', target, overrides: {harnessConversation: selected}});
    await entered.promise; selected.checkpointRef = 'checkpoint-B'; f.change({context: {...context(), revision: 2, selection: selected}});
    held.resolve({id: 'call', source: {kind: 'conversation', ownerId: 'session', id: 'call'}}); expect(await sending).toBe(true);
    const input = f.operations.getSnapshot()[0].input as unknown as {request: SubmissionRequest; contextDraft: unknown};
    expect(input.request.overrides?.harnessConversation).toMatchObject({checkpointRef: 'checkpoint-A'});
    expect(input.contextDraft).toMatchObject({revision: 1, selection: {checkpointRef: 'checkpoint-A'}});
    expect(input.request).not.toHaveProperty('contextDraft'); expect(f.config().context?.revision).toBe(2);
});

it.each(['checkpoint', 'revision', 'cleared', 'text', 'files', 'session', 'branch', 'target'])
('does not let an old accepted receipt consume a newer %s draft', async change => {
    const f = fixture(); await originalOperation(f); const held = latch<{operationId: string; status: 'accepted'}>();
    f.ctx.reconcileSubmission = () => held.promise;
    const checking = f.command.reconcile('call'); await Promise.resolve();
    if (change === 'checkpoint') f.change({context: {...context(), selection: {...context().selection, checkpointRef: 'checkpoint-B'}}});
    if (change === 'revision') f.change({context: {...context(), revision: 2}});
    if (change === 'cleared') f.change({context: undefined});
    if (change === 'text') f.change({text: 'New text'});
    if (change === 'files') f.files.push(new File(['new'], 'new.txt'));
    if (change === 'session') f.scope('another-session', 'main');
    if (change === 'branch') f.scope('session', 'review');
    if (change === 'target') f.change({target: {...target, version: '2'}});
    const current = structuredClone(f.config()); held.resolve({operationId: 'call', status: 'accepted'}); await checking;
    expect(f.config()).toEqual(current); expect(f.accept).not.toHaveBeenCalled();
    expect(f.operations.getSnapshot()[0].status).toBe('accepted'); expect(f.commands.execute).not.toHaveBeenCalled();
});

it('preserves a context already changed before a restored operation is queried', async () => {
    const f = fixture(); await originalOperation(f); f.change({context: {...context(), revision: 2}});
    await f.command.reconcile('call'); expect(f.accept).not.toHaveBeenCalled();
});

it('consumes only a matching persisted context revision after operation-ledger rehydration', async () => {
    const f = fixture(); await originalOperation(f);
    f.ctx.operations = createOperationLedger({initial: JSON.parse(JSON.stringify(f.operations.getSnapshot()))});
    await f.command.reconcile('call');
    expect(f.accept).toHaveBeenCalledWith('Original', [], 1, context()); expect(f.commands.execute).not.toHaveBeenCalled();
});

it('keeps explicit context when an old operation lacks evidence', async () => {
    const f = fixture(); await originalOperation(f, undefined, false); await f.command.reconcile('call');
    expect(f.accept).not.toHaveBeenCalled();
});

it('keeps a reselected draft after confirming an older Submit and only creates a new operation on the next explicit send', async () => {
    const f = fixture(), info = vi.spyOn(Toast, 'info').mockImplementation(() => {}), error = vi.spyOn(Toast, 'error').mockImplementation(() => {});
    const feedback = vi.spyOn(f.ctx.historyView, 'setSubmission'); let accepted = false, allowNew = false;
    f.ctx.reconcileSubmission = async request => ({operationId: request.submission!.id, status: accepted ? 'accepted' : 'unknown'});
    f.commands.execute.mockImplementation(async (name, request) => {
        if (name !== SessionCommand.Submit) return {items: []};
        if (!allowNew) throw new Error('Transport unknown'); return request.submission.id;
    });
    const params = {text: 'Original', files: [], agentId: 'worker', target};
    try {
        expect(await f.command.run(params)).toBe(false); const original = f.operations.getSnapshot()[0].context.operationId;
        f.change({context: {...context(), revision: 2}}); const newer = structuredClone(f.config()); accepted = true; error.mockClear();
        expect(await f.command.run(params)).toBe(false);
        expect(f.config()).toEqual(newer); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
        expect(feedback).toHaveBeenLastCalledWith(expect.objectContaining({id: original, state: 'accepted', error: undefined}));
        expect(info).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
        expect(f.commands.execute.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(1);
        allowNew = true; expect(await f.command.run(params)).toBe(true);
        expect(f.operations.getSnapshot()).toHaveLength(2); expect(f.operations.getSnapshot()[1].context.operationId).not.toBe(original);
        expect(f.commands.execute.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(2);
        expect((f.operations.getSnapshot()[1].input as {contextDraft?: unknown}).contextDraft).toMatchObject({revision: 2});
    } finally {info.mockRestore(); error.mockRestore();}
});


it.each([true, false])('uses the supplied draft snapshot instead of the later composer selection (selected=%s)', async selected => {
    const f = fixture(), captured = structuredClone(f.config());
    if (!selected) captured.context = undefined;
    f.change({context: {...context(), revision: 2, selection: {...context().selection, checkpointRef: 'checkpoint-B'}}});
    f.ctx.resolveSubmission = async () => ({id: 'call', source: {kind: 'conversation', ownerId: 'session', id: 'call'}});
    expect(await f.command.run({text: captured.text, files: [], agentId: 'worker', target, draftConfig: captured})).toBe(true);
    const input = f.operations.getSnapshot()[0].input as unknown as {request: SubmissionRequest; contextDraft?: unknown};
    expect(input.request.overrides?.harnessConversation).toEqual(selected ? context().selection : undefined);
    expect(input.contextDraft).toEqual(selected ? context() : undefined);
    expect(f.config().context?.selection).toMatchObject({checkpointRef: 'checkpoint-B'});
});

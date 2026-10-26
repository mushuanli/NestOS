// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import type {ContextOptionsPage, ContextOptionsQuery} from '@itookit/llm-session/contracts';
import type {InputContextDraft} from '../../llm-ui-adapter/src/domain/context-draft';
import {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {WorkspaceContextPicker, type ContextPickerState} from '../../llm-ui-adapter/src/components/input/WorkspaceContextPicker';
import {RpcPeer} from '@itookit/app-transport/application';
import {createOperationLedger} from '@itookit/llm-ui';
import {SessionCommand, type SubmissionRequest, type SessionInstructionQueue, type ICommandBus} from '@itookit/llm-session/contracts';
import {submitSessionCall} from '../../llm-ui-adapter/src/commands/submit-session-call';
import type {CommandContext} from '../../llm-ui-adapter/src/commands/CommandContext';
import {SendMessageCommand} from '../../llm-ui-adapter/src/commands/SendMessageCommand';

const target = {kind: 'agent' as const, id: 'harness', version: '1', digest: 'published'};
const scope = {sessionId: 'session', branchId: 'main'};
const selection = {mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 3, expectedGeneration: 1, checkpointRef: 'old-point'};
const draft = (): InputContextDraft => ({revision: 1, ...scope, target, selection: {...selection}});
const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).reverse().forEach(close => close()); document.body.replaceChildren(); vi.restoreAllMocks();});

function page(query: ContextOptionsQuery, revision = 3): ContextOptionsPage {
    return {...scope, ...query, kind: 'direct-harness', basis: 'a'.repeat(64), revision: 1, dynamicPolicy: 'dispatch-validation-required',
        modes: {new: {supported: true}, fork: {supported: true}, continue: {supported: false, code: 'CONTEXT_NATIVE_WRITE_UNSUPPORTED'}},
        sources: [{ref: {bindingId: 'binding', revision, generation: 1}, branchId: 'source-branch', targetRef: 'opaque-host-target', connectionId: 'connection',
            validity: 'valid', busy: false, knownHeadRef: 'latest-point', checkpointCount: 2, fork: {status: 'static-compatible', codes: []}}],
        ...(query.bindingId ? {checkpoints: ['old-point', 'latest-point'].map(ref => ({ref, kind: 'terminal' as const, invocationId: 'invocation', fork: {status: 'static-compatible' as const, codes: []}}))} : {})};
}
function click(host: HTMLElement, action: string): void {host.querySelector<HTMLButtonElement>(`[data-context-action="${action}"]`)!.click();}
async function choose(host: HTMLElement, index = 0): Promise<void> {
    click(host, 'open'); await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[data-context-binding="0"]')?.disabled).toBe(false));
    host.querySelector<HTMLButtonElement>('[data-context-binding="0"]')!.click();
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>(`[data-context-checkpoint="${index}"]`)?.disabled).toBe(false));
    host.querySelector<HTMLButtonElement>(`[data-context-checkpoint="${index}"]`)!.click(); click(host, 'confirm');
}
async function inputFixture(context?: InputContextDraft, provider = vi.fn(async (query: ContextOptionsQuery) => page(query))) {
    const host = document.createElement('div'); document.body.append(host); const currentScope = {...scope}, onSend = vi.fn(async () => {});
    const input = new ChatInput(host, {onSend, onStop() {}, contextOptions: provider, contextScope: () => currentScope,
        requestCallTargets: async () => ({entries: [{target, name: 'Harness'}], issues: []}),
        initialAgents: [{id: 'harness', name: 'Harness', execution: {kind: 'harness', connectionId: 'connection'}}],
        initialConfig: {agentId: 'harness', target, text: 'Original input', context}});
    cleanups.push(() => input.destroy()); await input.refreshCallTargets();
    return {host, input, provider, onSend, scope: currentScope, send: () => host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click()};
}

it('keeps the default context in the input menu without a technical status row', async () => {
    const f = await inputFixture();
    const picker = f.host.querySelector<HTMLElement>('.workspace-context')!;
    expect(picker.closest('.llm-input__options-body')).not.toBeNull();
    expect(f.host.querySelector('[data-independent-call]')?.closest('.llm-input__options-body')).not.toBeNull();
    expect(picker.querySelector('[data-context-action="open"]')?.textContent).toBe(t('callable.context.title'));
    expect(picker.textContent).not.toContain(t('callable.context.new'));
    expect(f.host.querySelector<HTMLDetailsElement>('.llm-input__options')!.open).toBe(false);
});

it('selects an immutable earlier checkpoint only after confirmation and freezes no observation metadata', async () => {
    const f = await inputFixture(); await choose(f.host);
    expect(f.input.getConfig().context).toEqual(draft()); expect(f.host.textContent).toContain(t('callable.context.forkBoundary'));
    f.send(); await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(f.onSend.mock.calls[0][3]).toMatchObject({harnessConversation: selection});
    expect(JSON.stringify(f.onSend.mock.calls[0])).not.toContain('basis'); expect(f.input.getConfig().context).toBeUndefined();
});

it('preserves the selected old checkpoint and revision on catalog drift until the user explicitly selects and confirms again', async () => {
    let revision = 3; const f = await inputFixture(draft(), vi.fn(async query => page(query, revision)));
    revision = 4; click(f.host, 'verify');
    await vi.waitFor(() => expect(f.host.textContent).toContain('CONTEXT_BINDING_CHANGED'));
    expect(f.input.getConfig().context).toEqual(draft()); f.send(); await vi.waitFor(() => expect(f.provider.mock.calls.length).toBeGreaterThan(2));
    expect(f.onSend).not.toHaveBeenCalled(); await choose(f.host);
    expect(f.input.getConfig().context?.selection).toEqual({...selection, expectedBindingRevision: 4});
    expect(f.input.getConfig().context?.revision).toBe(2);
});

it.each(['branch', 'target', 'policy'])('keeps text and the selection when the %s changes and requires fresh qualification', async change => {
    const f = await inputFixture(draft()); const before = f.input.getConfig().context;
    if (change === 'branch') {f.scope.branchId = 'review'; f.input.setDraftScope('review');}
    if (change === 'target') f.input.setConfig({target: {...target, version: '2'}});
    if (change === 'policy') f.input.setConfig({settings: {systemPromptAppend: 'new policy'}});
    expect(f.input.getConfig().context).toEqual(before); expect(f.input.getConfig().text).toBe('Original input');
    expect(f.host.textContent).toContain(t('callable.context.revalidate'));
    f.send(); await vi.waitFor(() => expect(f.provider.mock.calls.length).toBeGreaterThan(0));
    if (change === 'branch') await vi.waitFor(() => expect(f.host.textContent).toContain('CONTEXT_DRAFT_SCOPE_CHANGED'));
    if (change !== 'policy') expect(f.onSend).not.toHaveBeenCalled(); else await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
});

it('keeps an existing fork on other targets while default chat does not depend on native context capability', async () => {
    const provider = vi.fn(async (query: ContextOptionsQuery) => ({...page(query), kind: 'other' as const,
        modes: {new: {supported: false}, fork: {supported: false}, continue: {supported: false}}, sources: []}));
    const f = await inputFixture(draft(), provider); await vi.waitFor(() => expect(provider).toHaveBeenCalled());
    expect(f.input.getConfig().context).toEqual(draft()); f.send(); await vi.waitFor(() => expect(f.host.textContent).toContain('CONTEXT_TARGET_UNSUPPORTED'));
    expect(f.onSend).not.toHaveBeenCalled(); click(f.host, 'clear'); f.send();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce()); expect(f.onSend.mock.calls[0][3]?.harnessConversation).toBeUndefined();
});

it('does not mount a context picker or lock ordinary chat when the optional provider is absent', async () => {
    const host = document.createElement('div'); document.body.append(host); const onSend = vi.fn(async () => {});
    const input = new ChatInput(host, {onSend, onStop() {}}); cleanups.push(() => input.destroy()); input.setConfig({text: 'ordinary'});
    expect(host.querySelector<HTMLElement>('.workspace-context')!.hidden).toBe(true);
    host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click(); await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
});

it('keeps a newer selection, text and attachments when an older accepted send returns', async () => {
    const f = await inputFixture(draft()); let resolve!: () => void;
    f.onSend.mockImplementationOnce(() => new Promise<void>(done => {resolve = done;})); f.send();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce()); click(f.host, 'clear'); await choose(f.host, 1);
    f.input.restoreDraft('new text', [new File(['attachment'], 'next.txt', {type: 'text/plain'})], 'harness');
    const newer = f.input.getConfig(); resolve(); await new Promise(done => setTimeout(done, 0));
    expect(f.input.getConfig()).toEqual(newer); expect(f.input.getDraftFiles()).toHaveLength(1);
});

it.each(['target', 'branch', 'session'])('preserves an unchanged context and the destination draft when only %s changes before old acceptance', async change => {
    const f = await inputFixture(draft()); let release!: () => void;
    f.onSend.mockImplementationOnce(() => new Promise<void>(done => {release = done;})); f.send();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    if (change === 'target') f.input.setConfig({target: {...target, version: '2'}});
    if (change === 'branch') {f.scope.branchId = 'review'; f.input.setDraftScope('review');}
    if (change === 'session') {f.scope.sessionId = 'another-session'; f.input.setDraftScope('another-session/main');}
    f.input.restoreDraft('New destination input', [new File(['next'], 'next.txt', {type: 'text/plain'})], 'harness');
    const newer = f.input.getConfig(); release(); await new Promise(done => setTimeout(done, 0));
    expect(f.input.getConfig()).toEqual(newer); expect(f.input.getDraftFiles()).toHaveLength(1);
    expect(f.input.getConfig().context).toEqual(draft());
});

it.each(['target', 'branch', 'session', 'missing-provider'])('makes the direct acceptance port preserve explicit context after %s changes', async change => {
    const f = await inputFixture(draft()); const revision = f.input.getDraftRevision();
    if (change === 'target') f.input.setConfig({target: {...target, version: '2'}});
    if (change === 'branch') {f.scope.branchId = 'review'; f.input.setDraftScope('review');}
    if (change === 'session') {f.scope.sessionId = 'another-session'; f.input.setDraftScope('another-session/main');}
    if (change === 'missing-provider') f.input.adopt({onSend: f.onSend, onStop() {}, contextScope: () => f.scope,
        requestCallTargets: async () => ({entries: [{target, name: 'Harness'}], issues: []})});
    f.input.restoreDraft('New destination input', [new File(['next'], 'next.txt', {type: 'text/plain'})], 'harness');
    const newer = f.input.getConfig(); f.input.acceptSubmittedDraft('Original input', [], revision, draft());
    expect(f.input.getConfig()).toEqual(newer); expect(f.input.getDraftFiles()).toHaveLength(1);
    if (change === 'missing-provider') {
        await f.input.refreshCallTargets(); f.send();
        await vi.waitFor(() => expect(f.host.textContent).toContain('CONTEXT_OPTIONS_UNAVAILABLE'));
        expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.getConfig()).toEqual(newer);
    }
});

it('preserves an ordinary formally scoped draft after the Session changes while acceptance is pending', async () => {
    const f = await inputFixture(); let release!: () => void;
    f.onSend.mockImplementationOnce(() => new Promise<void>(done => {release = done;})); f.send();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce()); f.scope.sessionId = 'another-session';
    f.input.setDraftScope('another-session/main'); f.input.restoreDraft('Other Session input', [new File(['next'], 'next.txt')], 'harness');
    const newer = f.input.getConfig(); release(); await new Promise(done => setTimeout(done, 0));
    expect(f.input.getConfig()).toEqual(newer); expect(f.input.getDraftFiles()).toHaveLength(1);
});

it('uses increasing revisions across clearing and selecting the same point to protect an old acceptance from ABA', async () => {
    const f = await inputFixture(draft()), revision = f.input.getDraftRevision();
    click(f.host, 'clear'); await choose(f.host); expect(f.input.getConfig().context?.revision).toBe(2);
    f.input.acceptSubmittedDraft('Original input', [], revision, draft());
    expect(f.input.getConfig().text).toBe('Original input'); expect(f.input.getConfig().context?.revision).toBe(2);
});

it.each(['newer-failure', 'newer-success'])('discards an older same-scope validation response after %s', async order => {
    const host = document.createElement('div'); document.body.append(host);
    let request = 0, old!: (value: ContextOptionsPage) => void;
    const state: ContextPickerState = {scope, target, draft: draft()};
    const provider = vi.fn(async (query: ContextOptionsQuery) => {
        if (++request === 2) return new Promise<ContextOptionsPage>(resolve => {old = resolve;});
        if (request === 3 && order === 'newer-failure') throw Object.assign(new Error('private'), {code: 'NATIVE_EPOCH_CHANGED'});
        return page(query);
    });
    const picker = new WorkspaceContextPicker(host, () => provider, () => {}); cleanups.push(() => picker.destroy()); picker.update(state);
    await vi.waitFor(() => expect(request).toBe(1)); const first = picker.prepare(); await vi.waitFor(() => expect(old).toBeTypeOf('function'));
    const newer = await picker.prepare(); expect(newer).toBe(order === 'newer-success');
    old(page({...scope, target}, 3)); expect(await first).toBe(false);
    if (order === 'newer-failure') expect(host.textContent).toContain('NATIVE_EPOCH_CHANGED'); else expect(host.textContent).not.toContain('校验失败');
});

it('ignores a stale same-scope validation failure after a newer successful validation', async () => {
    const host = document.createElement('div'); document.body.append(host); let request = 0, rejectOld!: (error: Error) => void;
    const provider = vi.fn(async (query: ContextOptionsQuery) => ++request === 2
        ? new Promise<ContextOptionsPage>((_resolve, reject) => {rejectOld = reject;}) : page(query));
    const picker = new WorkspaceContextPicker(host, () => provider, () => {}); cleanups.push(() => picker.destroy()); picker.update({scope, target, draft: draft()});
    await vi.waitFor(() => expect(request).toBe(1)); const older = picker.prepare(); await vi.waitFor(() => expect(rejectOld).toBeTypeOf('function'));
    expect(await picker.prepare()).toBe(true); rejectOld(Object.assign(new Error('private payload'), {code: 'OLD_CONNECTION_ERROR'}));
    expect(await older).toBe(false); expect(host.textContent).not.toContain('OLD_CONNECTION_ERROR'); expect(host.textContent).toContain(t('callable.context.dynamicPolicy'));
});

it('treats malformed qualification data as a local read failure and preserves the draft', async () => {
    const f = await inputFixture(draft(), vi.fn(async query => {
        const result = page(query); result.sources[0].fork.codes = ['private response body']; return result;
    }));
    await vi.waitFor(() => expect(f.host.textContent).toContain('CONTEXT_OPTIONS_RESPONSE_INVALID'));
    expect(f.host.textContent).not.toContain('private response body'); expect(f.input.getConfig().context).toEqual(draft());
    click(f.host, 'clear'); f.send(); await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
});

it('does not apply a late context page after scope change or destruction', async () => {
    const host = document.createElement('div'); document.body.append(host); let resolve!: (page: ContextOptionsPage) => void;
    const provider = vi.fn((query: ContextOptionsQuery) => new Promise<ContextOptionsPage>(done => {resolve = done;}));
    const picker = new WorkspaceContextPicker(host, () => provider, () => {}); picker.update({scope, target});
    const original = resolve; picker.update({scope: {...scope, branchId: 'review'}, target}); picker.destroy(); original(page({...scope, target}));
    await new Promise(done => setTimeout(done, 0)); expect(host.children).toHaveLength(0);
});

it('drops a changed catalog page without combining observations or modifying the frozen checkpoint', async () => {
    const provider = vi.fn(async (query: ContextOptionsQuery) => {
        if (query.cursor) throw Object.assign(new Error('private storage content'), {code: 'CONTEXT_CATALOG_CHANGED'});
        return {...page(query), nextCursor: {basis: 'a'.repeat(64), catalog: {revision: 1, after: 'binding', scope: 'b'.repeat(64)}}};
    });
    const f = await inputFixture(draft(), provider); click(f.host, 'open');
    await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('[data-context-action="more"]')?.disabled).toBe(false)); click(f.host, 'more');
    await vi.waitFor(() => expect(f.host.textContent).toContain('CONTEXT_CATALOG_CHANGED'));
    expect(f.host.textContent).not.toContain('private storage content'); expect(f.host.querySelector('[data-context-binding]')).toBeNull();
    expect(f.input.getConfig().context).toEqual(draft());
});

it('loads checkpoint pages on explicit demand and keeps an earlier point selectable after the latest head appears', async () => {
    const provider = vi.fn(async (query: ContextOptionsQuery) => {
        const result = page(query); if (!query.bindingId) return result;
        return {...result, checkpoints: query.cursor ? result.checkpoints!.slice(1) : result.checkpoints!.slice(0, 1),
            ...(!query.cursor ? {nextCursor: {basis: result.basis, catalog: {revision: 1, after: 'old-point', scope: 'b'.repeat(64)}}} : {})};
    });
    const f = await inputFixture(undefined, provider); click(f.host, 'open');
    await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('[data-context-binding="0"]')?.disabled).toBe(false));
    f.host.querySelector<HTMLButtonElement>('[data-context-binding="0"]')!.click();
    await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('[data-context-action="more"]')?.disabled).toBe(false));
    const before = provider.mock.calls.length; click(f.host, 'more');
    await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('[data-context-checkpoint="1"]')?.disabled).toBe(false));
    expect(provider.mock.calls.length).toBe(before + 1); f.host.querySelector<HTMLButtonElement>('[data-context-checkpoint="0"]')!.click(); click(f.host, 'confirm');
    expect(f.input.getConfig().context?.selection).toEqual(selection);
});

it('seeds a reopened selector revision from existing operation recovery evidence', async () => {
    const host = document.createElement('div'); document.body.append(host); let selected: InputContextDraft | undefined;
    const picker = new WorkspaceContextPicker(host, () => async query => page(query), value => {selected = value;}, () => 9);
    cleanups.push(() => picker.destroy()); picker.update({scope, target}); await choose(host);
    expect(selected?.revision).toBe(10); expect(selected?.selection).toEqual(selection);
});

it('keeps selection and enqueue available while the original application RPC send response remains suspended', async () => {
    let server!: RpcPeer, release!: (id: string) => void; const operations = createOperationLedger();
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    const seen: SubmissionRequest[] = [], listeners = new Set<(queue: SessionInstructionQueue) => void>();
    const source = {execute: vi.fn(async (name: string, args: unknown) => {
        if (name === SessionCommand.ContextOptions) return page(args as ContextOptionsQuery);
        const request = args as SubmissionRequest; seen.push(request);
        if (seen.length === 1) return new Promise<string>(resolve => {release = resolve;}); return request.submission!.id;
    })};
    const commands = client.decode(await server.expose(source)) as ICommandBus;
    const f = await inputFixture(draft(), vi.fn(query => commands.execute<ContextOptionsPage>(SessionCommand.ContextOptions, query)));
    const ctx = {commands, operations, getSessionId: () => scope.sessionId,
        observeInstructions: (listener: (queue: SessionInstructionQueue) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
        reconcileSubmission: async (request: SubmissionRequest) => ({operationId: request.submission!.id, status: 'accepted'})} as unknown as CommandContext;
    f.onSend.mockImplementation(async (...args: unknown[]) => {
        const id = `submission-${seen.length + 1}`, request: SubmissionRequest = {expectedSessionId: scope.sessionId, expectedBranch: scope.branchId, target, expectedTarget: target,
            source: {kind: 'composer', text: args[0] as string, attachments: [], values: {}}, overrides: args[3] as SubmissionRequest['overrides'],
            submission: {id, source: {kind: 'conversation', ownerId: scope.sessionId, id}}};
        await submitSessionCall(ctx, request, id, f.input.getConfig().context);
    });
    try {
        f.send(); await vi.waitFor(() => expect(seen).toHaveLength(1)); await choose(f.host, 1);
        const next = f.input.getConfig().context; f.input.setConfig({text: 'Next queued input'});
        for (const listener of listeners) listener({sessionId: scope.sessionId, revision: 1, paused: false, items: [{id: seen[0].submission!.id, sendIntent: {submission: seen[0].submission}}]} as SessionInstructionQueue);
        await vi.waitFor(() => expect(operations.getSnapshot()[0].status).toBe('accepted'));
        await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
        expect(f.input.getConfig().context).toEqual(next); expect(f.input.getConfig().text).toBe('Next queued input');
        f.send(); await vi.waitFor(() => expect(seen).toHaveLength(2));
        expect(seen[0].overrides?.harnessConversation).toEqual(selection); expect(seen[1].overrides?.harnessConversation).toEqual(next!.selection);
        release(seen[0].submission!.id); await client.whenIdle(); expect(seen).toHaveLength(2);
    } finally {release?.(seen[0]?.submission?.id ?? 'submission-1'); await client.close(); await server.close();}
});

it('preserves a reselected same checkpoint when explicit reconciliation confirms an earlier operation, then permits a new call', async () => {
    const f = await inputFixture(draft()), operations = createOperationLedger(), requests: SubmissionRequest[] = [];
    let status: 'unknown' | 'accepted' = 'unknown';
    const commands = {execute: vi.fn(async (name: string, value?: unknown) => {
        if (name !== SessionCommand.Submit) return {items: []};
        const request = structuredClone(value as SubmissionRequest); requests.push(request);
        if (requests.length === 1) throw new Error('Submission reply unavailable'); return request.submission!.id;
    })};
    const ctx = {chatInput: f.input, operations, commands, getSessionId: () => scope.sessionId, getBranch: () => scope.branchId,
        observeInstructions: () => () => {}, reconcileSubmission: async (request: SubmissionRequest) => ({operationId: request.submission!.id, status}),
        errorHandler: {wrap: (work: () => Promise<unknown>) => work()}, historyView: {scrollToBottom() {}, setSubmission() {}}, isGenerating: () => false} as unknown as CommandContext;
    const command = new SendMessageCommand(ctx);
    f.onSend.mockImplementation(async (...args: unknown[]) => await command.run({text: args[0] as string, files: args[1] as File[], agentId: args[2] as string,
        overrides: args[3] as SubmissionRequest['overrides'], target: args[4] as typeof target}) ? undefined : false);
    f.send(); await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('unknown'));
    await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
    click(f.host, 'clear'); await choose(f.host); const newer = f.input.getConfig(); expect(newer.context?.revision).toBe(2);
    status = 'accepted'; await command.reconcile(operations.getSnapshot()[0].context.operationId);
    expect(operations.getSnapshot()[0].status).toBe('accepted');
    await vi.waitFor(() => expect(f.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
    expect(requests).toHaveLength(1); expect(operations.getSnapshot()).toHaveLength(1); expect(f.input.getConfig()).toEqual(newer);
    f.send(); await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() => expect(operations.getSnapshot()[1].status).toBe('accepted'));
    await vi.waitFor(() => expect(f.input.getConfig().context).toBeUndefined()); expect(f.input.getConfig().text).toBe('');
    expect(requests[1].submission!.id).not.toBe(requests[0].submission!.id);
    expect({...requests[1], submission: undefined}).toEqual({...requests[0], submission: undefined});
    expect(operations.getSnapshot().map(record => (record.input as {contextDraft: InputContextDraft}).contextDraft.revision)).toEqual([1, 2]);
});


it('preserves attachments after the target changes without an optional context scope provider', async () => {
    const host = document.createElement('div'); document.body.append(host);
    let release!: () => void;
    const onSend = vi.fn(() => new Promise<void>(done => {release = done;}));
    const input = new ChatInput(host, {onSend, onStop() {}}); cleanups.push(() => input.destroy());
    input.setConfig({target});
    const file = new File(['original'], 'original.txt', {type: 'text/plain'});
    input.restoreDraft('Original input', [file], 'harness');
    host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    input.setConfig({target: {...target, version: '2'}});
    const newer = input.getConfig(); release();
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
    expect(input.getConfig()).toEqual(newer); expect(input.getDraftFiles()).toEqual([file]);
});

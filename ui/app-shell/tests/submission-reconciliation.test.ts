// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {SendMessageCommand} from '../../llm-ui-adapter/src/commands/SendMessageCommand';
import type {CommandContext} from '../../llm-ui-adapter/src/commands/CommandContext';
import type {SubmissionReceipt, SubmissionRequest} from '@itookit/llm-session/contracts';

const cleanup: Array<() => void> = [];
afterEach(() => {cleanup.splice(0).forEach(close => close()); document.body.replaceChildren();});

async function setup() {
    const target = {kind: 'flow' as const, id: 'worker', version: '1', digest: 'published'};
    const draft = {target, targetId: 'worker', signature: {id: 'worker', revision: 1, digest: 'published'}, revision: 1, json: '{"count":7}'};
    const request: SubmissionRequest = {target, expectedTarget: target, expectedSessionId: 'session', expectedBranch: 'main',
        source: {kind: 'arguments', value: {count: 7}}, presentation: {text: 'Original'},
        submission: {id: 'uncertain', source: {kind: 'conversation', ownerId: 'session', id: 'uncertain'}}};
    const operations = createOperationLedger({initial: [{context: {viewId: 'old', operationId: 'uncertain'},
        kind: 'send', conversationId: 'session', status: 'unknown', input: JSON.parse(JSON.stringify({request}))}]});
    const host = document.createElement('div'); document.body.append(host);
    const send = vi.fn(), commands = {execute: vi.fn()};
    const input = new ChatInput(host, {initialConfig: {text: 'Original', agentId: '', target, input: draft}, onSend: send, onStop() {},
        requestCallTargets: async () => ({entries: [{target, name: 'Worker'}], issues: []})});
    cleanup.push(() => input.destroy()); await input.refreshCallTargets(); input.setDraftScope('main');
    let branch = 'main', finish!: (receipt: SubmissionReceipt) => void;
    const reconcileSubmission = vi.fn(() => new Promise<SubmissionReceipt>(resolve => {finish = resolve;}));
    const ctx = {operations, commands, chatInput: input, getSessionId: () => 'session', getBranch: () => branch, reconcileSubmission} as unknown as CommandContext;
    const command = new SendMessageCommand(ctx);
    return {input, draft, operations, command, send, commands, reconcileSubmission, finish: () => finish({operationId: 'uncertain', status: 'accepted', evidence: 'queue'}),
        branch: (value: string) => {branch = value; input.setDraftScope(value);}};
}

it.each(['text', 'branch', 'arguments'])('reconciles the original receipt without consuming a newer %s draft or dispatching input', async change => {
    const f = await setup(), checking = f.command.reconcile('uncertain');
    await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledOnce());
    if (change === 'text') f.input.setConfig({text: 'Newer input'});
    if (change === 'branch') f.branch('review');
    if (change === 'arguments') f.input.setConfig({input: {...f.draft, revision: 2, json: '{"count":8}'}});
    const newer = f.input.getConfig(); f.finish(); await checking;
    expect(f.input.getConfig()).toEqual(newer); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
    expect(f.send).not.toHaveBeenCalled(); expect(f.commands.execute).not.toHaveBeenCalled();
});

it.each(['hidden', 'destroyed'])('keeps the draft when its view becomes %s during reconciliation while preserving the durable receipt', async change => {
    const f = await setup(); let active = true;
    const checking = f.command.reconcile('uncertain', () => active);
    await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledOnce());
    if (change === 'hidden') active = false;
    else f.input.destroy();
    const saved = f.input.getConfig(); f.finish(); await checking;
    expect(f.input.getConfig()).toEqual(saved); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
    expect(f.send).not.toHaveBeenCalled(); expect(f.commands.execute).not.toHaveBeenCalled();
});

it('does not consume another branch attachment when an earlier send is accepted', async () => {
    const host = document.createElement('div'); document.body.append(host);
    let finish!: () => void;
    const sending = new Promise<void>(resolve => {finish = resolve;}), onSend = vi.fn(() => sending);
    const input = new ChatInput(host, {onSend, onStop() {}}); cleanup.push(() => input.destroy());
    const file = new File(['shared selection'], 'notes.txt', {type: 'text/plain'});
    input.setDraftScope('main'); input.restoreDraft('First branch', [file], 'default');
    host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    input.setDraftScope('review'); input.acceptSubmittedDraft('', [file]); input.restoreDraft('Other branch', [file], 'default');
    finish(); await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
    expect(input.getConfig().text).toBe('Other branch'); expect(input.getDraftFiles()).toEqual([file]);
});

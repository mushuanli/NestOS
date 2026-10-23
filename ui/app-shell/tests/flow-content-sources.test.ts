// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentTransferCommand, FlowInvocationCommand, type ContentCapture, type ContentTransfer, type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { invokeFlowText } from '../../llm-ui-adapter/src/flows/invoke-flow';
import { promptChildConversation } from '../../llm-ui-adapter/src/flows/create-child';
import { t } from '@itookit/common';

const source: ContentCapture = {id: 'capture', sessionId: 's', branch: 'main', head: 'round-1', createdAt: 1,
    messages: [{id: 'm1', roundId: 'round-1', role: 'user', text: 'Question'}, {id: 'm2', roundId: 'round-1', role: 'assistant', text: 'Reply'}], outputs: []};
let transfer: ContentTransfer, execute: ReturnType<typeof vi.fn>, commands: ICommandBus;
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
    transfer = {id: 'transfer', sessionId: 's', captureId: 'capture', branch: 'main', head: 'round-1', createdAt: 2,
        selection: {kind: 'latest'}, messageIds: ['m2'], value: 'Reply'};
    execute = vi.fn(async (command, input) => {
        if (command === FlowCommand.DraftList) return [{id: 'f', name: 'Flow'}];
        if (command === FlowCommand.DraftLoad) return {id: 'f', name: 'Flow', draftVersion: 1, parameters: [{name: 'text', type: 'string', required: true}]};
        if (command === SessionCommand.GetConnections) return {connections: []};
        if (command === SessionCommand.CheckFlowConnections) return {valid: true};
        if (command === FlowCommand.RevisionCreate) return {revision: {id: 'f', name: 'Flow', revision: 1}};
        if (command === ContentTransferCommand.Capture) return structuredClone(source);
        if (command === ContentTransferCommand.Resolve) return {...transfer, selection: input.selection};
        if (command === ContentTransferCommand.CreateChild) return {sessionId: 'child'};
        if (command === FlowInvocationCommand.Invoke) return {};
        throw new Error(command);
    });
    commands = {execute} as unknown as ICommandBus;
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const select = (element: HTMLSelectElement, value: string) => { element.value = value; element.dispatchEvent(new Event('change', {bubbles: true})); };
const submit = () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
async function choose(kind: string): Promise<void> {
    select(document.querySelector<HTMLSelectElement>('[data-content-source]')!, kind);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(ContentTransferCommand.Capture, {sessionId: 's'}));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-source-apply]')!.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>('[data-source-apply]')!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLDetailsElement>('[data-source-preview]')!.hidden).toBe(false));
}

it('binds an explicitly prepared source to its typed parameter and persists the provenance reference', async () => {
    const pending = invokeFlowText(commands, 's', 'f');
    await vi.waitFor(() => expect(document.querySelector('[data-content-source]')).not.toBeNull());
    await choose('latest');
    expect(document.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!.value).toBe('Reply');
    expect(document.querySelector('[data-source-preview]')!.textContent).toContain('Reply');
    submit(); expect(await pending).toBe(true);
    expect(execute).toHaveBeenCalledWith(FlowInvocationCommand.Invoke, expect.objectContaining({sessionId: 's', parameters: {text: 'Reply'},
        inputSources: {text: {sessionId: 's', id: 'transfer'}}}));
});

it('requires preparation, preserves the form on summary errors, and allows manual correction', async () => {
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, input) => command === ContentTransferCommand.Resolve ? Promise.reject(new Error('CONTENT_SUMMARY_INPUT_TOO_LARGE')) : original(command, input));
    const pending = invokeFlowText(commands, 's', 'f {"text":"keep my input"}');
    await vi.waitFor(() => expect(document.querySelector('[data-content-source]')).not.toBeNull());
    select(document.querySelector<HTMLSelectElement>('[data-content-source]')!, 'summary');
    submit(); await vi.waitFor(() => expect(document.querySelector('[data-form-error]')!.textContent).toBe(t('flow.source.notPrepared')));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-source-apply]')!.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>('[data-source-apply]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-source-error]')!.textContent).toBe(t('flow.source.error.CONTENT_SUMMARY_INPUT_TOO_LARGE')));
    const field = document.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!;
    expect(field.value).toBe('keep my input'); field.value = 'manual summary'; field.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLSelectElement>('[data-content-source]')!.value).toBe('custom');
    submit(); expect(await pending).toBe(true);
    expect(execute).toHaveBeenCalledWith(FlowInvocationCommand.Invoke, expect.objectContaining({parameters: {text: 'manual summary'}}));
});

it('keeps the frozen capture across source changes and discards source responses after closing', async () => {
    let finish!: (value: ContentTransfer) => void;
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, input) => command === ContentTransferCommand.Resolve ? new Promise(resolve => { finish = resolve; }) : original(command, input));
    const pending = invokeFlowText(commands, 's', 'f');
    await vi.waitFor(() => expect(document.querySelector('[data-content-source]')).not.toBeNull());
    select(document.querySelector<HTMLSelectElement>('[data-content-source]')!, 'latest');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(ContentTransferCommand.Capture, {sessionId: 's'}));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-source-apply]')!.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>('[data-source-apply]')!.click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); expect(await pending).toBe(false);
    finish(transfer); await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('dialog')).toBeNull();
    expect(execute.mock.calls.some(([command]) => command === FlowInvocationCommand.Invoke)).toBe(false);
});

it('retries a child Flow admission with the same child intent and invocation identity', async () => {
    let rejected = false; const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, input) => {
        if (command === FlowInvocationCommand.Invoke && !rejected) { rejected = true; throw new Error('receipt lost'); }
        return original(command, input);
    });
    const open = vi.fn(), pending = invokeFlowText(commands, 's', 'f {"text":"material"}', undefined, open);
    await vi.waitFor(() => expect(document.querySelector('.flow-launch-location select')).not.toBeNull());
    select(document.querySelector<HTMLSelectElement>('.flow-launch-location select')!, 'child');
    submit(); await vi.waitFor(() => expect(document.querySelector('[data-form-error]')!.textContent).toBe('receipt lost'));
    submit(); expect(await pending).toBe(true);
    const calls = execute.mock.calls.filter(([command]) => command === FlowInvocationCommand.Invoke).map(([, input]) => input);
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]); expect(calls[0].sessionId).toBe('child');
    expect(open).toHaveBeenCalledExactlyOnceWith('child');
});

it('creates a named child with an explicitly selected initial material', async () => {
    const abort = new AbortController(), pending = promptChildConversation(commands, 's', abort.signal);
    await vi.waitFor(() => expect(document.querySelector('[data-content-source]')).not.toBeNull());
    document.querySelector<HTMLInputElement>('[data-parameter="0"]')!.value = 'Independent review';
    await choose('latest'); submit(); expect(await pending).toBe('child');
    expect(execute).toHaveBeenCalledWith(ContentTransferCommand.CreateChild, expect.objectContaining({sessionId: 's', title: 'Independent review', transfer: {sessionId: 's', id: 'transfer'}}));
    expect(execute.mock.calls.some(([command]) => command === FlowInvocationCommand.Invoke)).toBe(false);
});

it('does not launch after cancellation while the flow revision is being prepared', async () => {
    let finish!: (value: unknown) => void;
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, input) => command === FlowCommand.RevisionCreate
        ? new Promise(resolve => { finish = resolve; }) : original(command, input));
    const pending = invokeFlowText(commands, 's', 'f {"text":"prepared input"}');
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    submit(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); expect(await pending).toBe(false);
    finish({revision: {id: 'f', revision: 1}}); await Promise.resolve(); await Promise.resolve();
    expect(execute.mock.calls.some(([command]) => command === FlowInvocationCommand.Invoke || command === ContentTransferCommand.CreateChild)).toBe(false);
});

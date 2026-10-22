// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InputAssetCommand } from '@itookit/app-contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { ChatInput } from '../../llm-ui-adapter/src/components/input/ChatInputView';
import { prepareAgentFlow } from '../../llm-ui-adapter/src/flows/agent-flow';
import type { ExecutorOption } from '../../llm-ui-adapter/src/domain/types';

const views: ChatInput[] = [];
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const agent: ExecutorOption = { id: 'reader', name: 'Reader', execution: { kind: 'flow', flowId: 'registered', parameters: { lesson: 'agent-default' } }, availability: { status: 'ready' } };
const baseFlow = () => ({ id: 'registered', revision: 2, name: 'Registered flow', nodes: [], connections: [], parameters: [
    { name: 'lesson', type: 'string', default: 'flow-default' }, { name: 'images', type: 'json', widget: 'images' },
] });

function setup(initial = agent) {
    let flow = baseFlow();
    const asset = { kind: 'input', id: '11111111-1111-4111-8111-111111111111', mimeType: 'image/png', bytes: 7, sha256: 'a'.repeat(64) };
    const execute = vi.fn(async (name: string): Promise<unknown> => {
        if (name === FlowCommand.RevisionGet) return flow;
        if (name === SessionCommand.GetConnections) return { connections: [] };
        if (name === InputAssetCommand.Import) return asset;
        if (name === InputAssetCommand.Read) return 'data:image/png;base64,cGljdHVyZQ==';
    });
    const root = document.createElement('div'); document.body.append(root);
    const onSend = vi.fn(async () => {});
    const view = new ChatInput(root, { initialAgents: [initial], initialConfig: { agentId: initial.id },
        onSend, onStop() {}, onRequestConnections: async () => [],
        prepareAgentFlow: (choice, signal) => prepareAgentFlow({ execute } as never, choice, signal) });
    views.push(view);
    const input = root.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    const send = root.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
    return { root, view, onSend, execute, input, send, type, asset, changeFlow: (next: typeof flow) => { flow = next; } };
}

async function form(): Promise<HTMLDialogElement> {
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    return document.querySelector<HTMLDialogElement>('dialog')!;
}
function submit(dialog: HTMLDialogElement): void { dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); }

it('submits Flow Agent parameters and durable images through the ordinary send button without a default model', async () => {
    const f = setup(); await f.view.refreshConnections(); f.type('Read these pages');
    expect(f.send.disabled).toBe(false); expect(f.root.querySelector<HTMLElement>('.llm-input__model-trigger')!.hidden).toBe(true);
    f.send.click(); const dialog = await form();
    expect(dialog.textContent).toContain('${input.prompt}');
    const lesson = dialog.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!;
    expect(lesson.value).toBe('agent-default'); lesson.value = 'this request';
    const picker = dialog.querySelector<HTMLInputElement>('[data-image-picker]')!;
    Object.defineProperty(picker, 'files', { value: [new File(['picture'], 'page.png', { type: 'image/png' })] });
    picker.dispatchEvent(new Event('change')); submit(dialog);
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(f.onSend.mock.calls[0]).toEqual(['Read these pages', [], 'reader', expect.objectContaining({
        flowParameters: { lesson: 'this request', images: [{ type: 'image', source: { type: 'asset', asset: f.asset } }] }, flowConnectionBindings: {},
    })]);
    expect(f.onSend.mock.calls[0][3]).not.toHaveProperty('flowId');
    expect(f.execute).toHaveBeenCalledWith(InputAssetCommand.Import, expect.objectContaining({ url: expect.stringMatching(/^data:image\/png/) }));
    await vi.waitFor(() => expect(f.input.value).toBe(''));
});

it('keeps a selected disabled Agent and its draft, disables the picker option, and resumes only after availability refresh', async () => {
    const f = setup(); await f.view.refreshConnections(); f.type('Preserve this prompt');
    const disabled = { ...agent, availability: { status: 'disabled' as const, reason: 'flow-missing' as const } };
    f.view.refreshAgents([disabled], id => id);
    expect(f.view.getConfig().agentId).toBe('reader'); expect(f.send.disabled).toBe(true);
    expect(f.root.querySelector('[data-agent-unavailable]')!.textContent).toContain('流程');
    f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Preserve this prompt');
    f.root.querySelector<HTMLButtonElement>('.llm-input__agent-trigger')!.click();
    expect(document.querySelector('[role="option"]')!.getAttribute('aria-disabled')).toBe('true');
    f.view.refreshAgents([agent], id => id);
    expect(f.send.disabled).toBe(false); expect(f.onSend).not.toHaveBeenCalled();
});

it('loads current published fields on each send and preserves input after cancellation', async () => {
    const f = setup(); f.type('Keep prompt'); f.send.click();
    (await form()).querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    await vi.waitFor(() => expect(f.send.disabled).toBe(false));
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Keep prompt');
    f.changeFlow({ ...baseFlow(), parameters: [{ name: 'level', type: 'string', default: 'latest' }] });
    f.send.click(); const next = await form();
    expect(next.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!.value).toBe('latest');
    expect(next.querySelector('[name="lesson"]')).toBeNull(); submit(next);
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
});

it('aborts an open parameter form on Flow deletion and never sends through a fallback Agent', async () => {
    const f = setup(); f.type('Keep after deletion'); f.send.click(); await form();
    f.view.refreshAgents([{ ...agent, availability: { status: 'disabled', reason: 'flow-missing' } }], id => id);
    await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Keep after deletion'); expect(f.send.disabled).toBe(true);
});

it('reads a pinned revision and cancels a hidden view without submitting its prompt', async () => {
    const f = setup({ ...agent, execution: { kind: 'flow', flowId: 'registered', revision: 1 } });
    f.type('Pinned prompt'); f.send.click(); await form();
    expect(f.execute).toHaveBeenCalledWith(FlowCommand.RevisionGet, { id: 'registered', revision: 1 });
    f.view.cancelPendingSend();
    await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Pinned prompt');
});

it('passes an explicit run connection selected in the shared Flow form', async () => {
    const f = setup();
    f.execute.mockImplementation(async (name: string) => {
        if (name === FlowCommand.RevisionGet) return baseFlow();
        if (name === SessionCommand.GetConnections) return { connections: [{ id: 'chosen', name: 'Chosen', providerId: 'provider', hasApiKey: true, credentialsReady: true }] };
    });
    f.type('Use selected run connection'); f.send.click(); const dialog = await form();
    dialog.querySelector<HTMLSelectElement>('[data-run-connection]')!.value = 'chosen'; submit(dialog);
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(f.onSend.mock.calls[0][3]).toMatchObject({ connectionId: 'chosen' });
});

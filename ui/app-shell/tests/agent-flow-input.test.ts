// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InputAssetCommand } from '@itookit/app-contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { ChatInput } from '../../llm-ui-adapter/src/components/input/ChatInputView';
import { prepareAgentFlow, type AgentFlowDraftInput } from '../../llm-ui-adapter/src/flows/agent-flow';
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
    const uploaded = new Map<string, typeof asset>();
    const execute = vi.fn(async (name: string, args?: any): Promise<unknown> => {
        if (name === FlowCommand.RevisionGet) return flow;
        if (name === SessionCommand.GetConnections) return { connections: [] };
        if (name === InputAssetCommand.Inspect) return uploaded.has(args.uploadId) ? {state: 'ready', reference: uploaded.get(args.uploadId)} : {state: 'missing'};
        if (name === InputAssetCommand.ImportFile) {
            Object.assign(asset, {id: args.uploadId, mimeType: args.mimeType, bytes: args.bytes, sha256: args.sha256});
            uploaded.set(args.uploadId, {...asset}); return {...asset};
        }
        if (name === InputAssetCommand.Read) return 'data:image/png;base64,cGljdHVyZQ==';
    });
    const root = document.createElement('div'); document.body.append(root);
    const onSend = vi.fn(async () => {});
    const commands = {execute};
    const prepare = vi.fn((choice: ExecutorOption, signal: AbortSignal, draft: AgentFlowDraftInput) => prepareAgentFlow(commands as never, choice, signal, draft));
    const view = new ChatInput(root, { initialAgents: [initial], initialConfig: { agentId: initial.id },
        onSend, onStop() {}, onRequestConnections: async () => [],
        prepareAgentFlow: prepare });
    views.push(view);
    const input = root.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    const send = root.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
    return { root, view, onSend, execute, commands, prepare, input, send, type, asset, changeFlow: (next: typeof flow) => { flow = next; } };
}

async function form(): Promise<HTMLDialogElement> {
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    return document.querySelector<HTMLDialogElement>('dialog')!;
}
function submit(dialog: HTMLDialogElement): void { dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); }

function sourceFlow(oneOf = false) {
    return {...baseFlow(), parameters: [
        {name: 'lesson', label: 'Lesson text', type: 'string', inputSource: 'composer.text'},
        {name: 'images', label: 'Page images', type: 'json', widget: 'images', inputSource: 'composer.attachments', imageConstraints: {mimeTypes: ['image/png'], maxItems: 2, maxBytes: 20}},
    ], ...(oneOf ? {inputGroups: [{name: 'source', label: 'Learning source', mode: 'oneOf', parameters: ['lesson', 'images']}]} : {})};
}

function chooseSource(dialog: HTMLElement, name: string): void {
    dialog.querySelector<HTMLInputElement>(`[data-flow-source="${name}"]`)!.click();
}

it('submits Flow Agent parameters and durable images through the ordinary send button without a default model', async () => {
    const f = setup(); await f.view.refreshConnections(); f.type('Read these pages');
    expect(f.send.disabled).toBe(false); expect(f.root.querySelector<HTMLElement>('.llm-input__model-trigger')!.hidden).toBe(true);
    f.send.click(); const dialog = await form();
    expect(dialog.textContent).toContain('确认输入内容');
    const lesson = dialog.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!;
    expect(lesson.value).toBe('agent-default'); lesson.value = 'this request';
    const picker = dialog.querySelector<HTMLInputElement>('[data-image-picker]')!;
    Object.defineProperty(picker, 'files', { value: [new File(['picture'], 'page.png', { type: 'image/png' })] });
    picker.dispatchEvent(new Event('change')); submit(dialog);
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(f.onSend.mock.calls[0]).toEqual(['Read these pages', [], 'reader', expect.objectContaining({
        flowParameters: { lesson: 'this request', images: [{ type: 'image', name: 'page.png', source: { type: 'asset', asset: f.asset } }] }, flowConnectionBindings: {},
    })]);
    expect(f.onSend.mock.calls[0][3]).not.toHaveProperty('flowId');
    expect(f.execute).toHaveBeenCalledWith(InputAssetCommand.ImportFile, expect.objectContaining({data: expect.any(ArrayBuffer), name: 'page.png'}));
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

it('sends a configured Composite without an empty run-parameter dialog and checks its Agent connection context', async () => {
    const f = setup({...agent, composition: {coordinatorAgentId: 'host', memberAgentIds: ['member']}});
    f.changeFlow({...baseFlow(), parameters: []}); await f.view.refreshConnections();
    f.type('Coordinate this request'); f.send.click();
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(document.querySelector('dialog')).toBeNull();
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.CheckFlowConnections, expect.objectContaining({agentId: 'reader'}));
    expect(f.onSend.mock.calls[0][3]).toMatchObject({flowParameters: {}});
});

it('prefills required Flow slots from this Agent purpose defaults before the system defaults', async () => {
    const f = setup({...agent, modelDefaults: {chat: 'agent-chat'}}), previous = f.execute.getMockImplementation()!;
    f.changeFlow({...baseFlow(), connections: [{name: 'analysis', requirements: {operation: 'chat'}}]} as never);
    f.execute.mockImplementation(async name => name === SessionCommand.GetConnections ? {
        modelDefaults: {chat: 'system-chat'}, connections: ['agent-chat', 'system-chat'].map(id => ({id, name: id, providerId: 'p', credentialsReady: true})),
    } : previous(name));
    await f.view.refreshConnections(); f.type('Use the assigned model'); f.send.click(); const dialog = await form();
    expect(dialog.querySelector<HTMLSelectElement>('[data-slot-connection="0"]')!.value).toBe('agent-chat');
    dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
});

it('passes the clicked text and attachment snapshot to preparation and keeps newer composer edits after confirmation', async () => {
    const f = setup(), file = new File(['context'], 'context.txt', {type: 'text/plain'});
    f.changeFlow({...baseFlow(), parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'},
        {name: 'files', type: 'json', widget: 'files', inputSource: 'composer.attachments'}]} as never);
    f.view.restoreDraft('Frozen prompt', [file], 'reader'); f.send.click(); const dialog = await form();
    expect(f.prepare.mock.calls[0][2]).toEqual({text: 'Frozen prompt', files: [file]});
    f.type('Newer prompt'); submit(dialog);
    await vi.waitFor(() => expect(f.send.disabled).toBe(false));
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Newer prompt'); expect(f.view.getDraftFiles()).toEqual([file]);
});

it('prefills only declared text and attachment sources in the initial dialog and keeps both when no exclusive group is declared', async () => {
    const f = setup(); f.changeFlow(sourceFlow() as never);
    const controller = new AbortController(), file = new File(['picture'], 'page.png', {type: 'image/png'});
    const prepared = prepareAgentFlow(f.commands as never, agent, controller.signal, {text: 'Composer lesson', files: [file]});
    const dialog = await form();
    expect(dialog.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!.value).toBe('Composer lesson');
    expect(dialog.querySelector('[data-flow-input-group]')).toBeNull();
    submit(dialog); const result = await prepared;
    expect(result?.flowParameters).toEqual({lesson: 'Composer lesson', images: [{type: 'image', name: 'page.png', source: {type: 'asset', asset: f.asset}}]});
    expect(f.execute.mock.calls.filter(call => call[0] === InputAssetCommand.ImportFile)).toHaveLength(1);
});

it('requires an explicit source choice for a declared exclusive group and submits only that source', async () => {
    const f = setup(); f.changeFlow(sourceFlow(true) as never); f.type('Composer text'); f.send.click(); const dialog = await form();
    expect(dialog.querySelector('[data-flow-input-group="source"] input:checked')).toBeNull();
    submit(dialog); await vi.waitFor(() => expect(dialog.querySelector('[data-form-error]')!.textContent).not.toBe(''));
    expect(f.onSend).not.toHaveBeenCalled(); chooseSource(dialog, 'lesson'); submit(dialog);
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(f.onSend.mock.calls[0][3]).toMatchObject({flowParameters: {lesson: 'Composer text'}});
    expect((f.onSend.mock.calls[0][3] as {flowParameters: object}).flowParameters).not.toHaveProperty('images');
});

it('keeps the original composer input and attachments when a source form is cancelled', async () => {
    const f = setup(); f.changeFlow(sourceFlow(true) as never);
    const file = new File(['document'], 'draft.txt', {type: 'text/plain'});
    f.view.restoreDraft('Keep source text', [file], 'reader'); f.send.click(); const dialog = await form();
    chooseSource(dialog, 'lesson'); dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    await vi.waitFor(() => expect(f.send.disabled).toBe(false));
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Keep source text'); expect(f.view.getDraftFiles()).toEqual([file]);
});

it('keeps invalid composer attachments and requires resolving their binding before switching to a text-only input', async () => {
    const f = setup(); f.changeFlow(sourceFlow(true) as never);
    const file = new File(['document'], 'draft.txt', {type: 'text/plain'});
    f.view.restoreDraft('Use this text instead', [file], 'reader'); f.send.click(); const dialog = await form();
    chooseSource(dialog, 'images'); submit(dialog);
    await vi.waitFor(() => expect(dialog.querySelector('[data-form-error]')!.textContent).toContain('draft.txt'));
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.input.value).toBe('Use this text instead'); expect(f.view.getDraftFiles()).toEqual([file]);
    chooseSource(dialog, 'lesson'); submit(dialog);
    await vi.waitFor(() => expect(dialog.querySelector('[data-form-error]')!.textContent).toContain('附件'));
    expect(f.onSend).not.toHaveBeenCalled(); expect(f.view.getDraftFiles()).toEqual([file]);
    dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    await vi.waitFor(() => expect(f.send.disabled).toBe(false));
    f.view.acceptSubmittedDraft('unmatched-text', [file]);
    f.send.click();
    const reopened = await form(); chooseSource(reopened, 'lesson'); submit(reopened);
    await vi.waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
    expect(f.onSend.mock.calls[0][3]).toMatchObject({flowParameters: {lesson: 'Use this text instead'}});
    expect(f.execute.mock.calls.filter(call => call[0] === InputAssetCommand.ImportFile)).toHaveLength(0);
});

it('reuses an imported composer image when cancellation reopens the same draft', async () => {
    const f = setup(); f.changeFlow(sourceFlow() as never);
    const file = new File(['picture'], 'page.png', {type: 'image/png'}), draft = {text: 'Keep context', files: [file]};
    const first = prepareAgentFlow(f.commands as never, agent, new AbortController().signal, draft), dialog = await form();
    await vi.waitFor(() => expect(dialog.querySelector<HTMLTextAreaElement>('[data-parameter="1"]')!.value).toContain(f.asset.id));
    dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); expect(await first).toBeNull();
    const second = prepareAgentFlow(f.commands as never, agent, new AbortController().signal, draft), reopened = await form();
    submit(reopened); expect((await second)?.flowParameters.images).toEqual([{type: 'image', name: 'page.png', source: {type: 'asset', asset: f.asset}}]);
    expect(f.execute.mock.calls.filter(call => call[0] === InputAssetCommand.ImportFile)).toHaveLength(1);
});

it('abandons a cancelled parameter form while a composer image import is still in flight', async () => {
    const f = setup(); f.changeFlow(sourceFlow() as never);
    let resolveImport!: (value: unknown) => void;
    const importing = new Promise(resolve => {resolveImport = resolve;}), previous = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (name, args) => name === InputAssetCommand.ImportFile ? importing : previous(name, args));
    const controller = new AbortController(), file = new File(['picture'], 'page.png', {type: 'image/png'});
    const prepared = prepareAgentFlow(f.commands as never, agent, controller.signal, {text: 'Keep context', files: [file]});
    await form(); await vi.waitFor(() => expect(f.execute.mock.calls.some(call => call[0] === InputAssetCommand.ImportFile)).toBe(true));
    controller.abort(); expect(await prepared).toBeNull(); resolveImport(f.asset);
    await Promise.resolve(); expect(document.querySelector('dialog')).toBeNull(); expect(f.onSend).not.toHaveBeenCalled();
});

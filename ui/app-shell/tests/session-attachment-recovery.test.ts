// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {FlowLibraryCommand, InputAssetCommand} from '@itookit/app-contracts';
import {SessionCommand, type SessionInstructionQueue, type SubmissionRequest} from '@itookit/llm-session/contracts';
import type {FlowDraft} from '@itookit/llm-flow/contracts';
import {LLMWorkspaceEditor} from '../../llm-ui-adapter/src/shell/LLMWorkspaceEditor';
import type {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {draftFileId} from '../../llm-ui-adapter/src/domain/draft-file-identity';
import {captureSubmissionDraft} from '../../llm-ui-adapter/src/domain/submission-draft';
import {fileBytes} from '../../llm-ui-adapter/src/utils/file-bytes';

vi.mock('@itookit/mdxeditor', async original => ({...await original<typeof import('@itookit/mdxeditor')>(),
    AssetResolverPlugin: class {}, MDxRenderer: class {
        markedExtensions: unknown[] = []; usePlugin() {return this;}
        async render(node: HTMLElement, text: string) {node.textContent = text;}
        async renderStreaming(node: HTMLElement, text: string) {node.textContent = text;}
        destroy() {}
    }, DefaultPrintService: class {async printFromHtml() {} destroy() {}},
}));
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function setup() {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}})); HTMLElement.prototype.scrollTo = vi.fn();
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const flow: FlowDraft = {id: 'files' as never, name: 'Files', draftVersion: 1, updatedAt: 0, parameters: [
        {name: 'request', type: 'string', inputSource: 'composer.text'},
        {name: 'documents', type: 'json', widget: 'files', required: true, inputSource: 'composer.attachments'},
    ], nodes: [{id: 'return' as never, name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
        config: {value: '${param.documents}'}}], edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const sessionId = await runtime.sessionRepository.createSession('Attachment recovery'), assets = await runtime.sessionRepository.openAttachments(sessionId);
    cleanup.push(() => assets.dispose());
    const original = runtime.commandBus.execute.bind(runtime.commandBus); let submitCalls = 0, fileUploads = 0, loseReply = true;
    vi.spyOn(runtime.commandBus, 'execute').mockImplementation(async (command, args) => {
        if (command === InputAssetCommand.ImportFile) fileUploads++;
        if (command === SessionCommand.Submit) {submitCalls++; if (loseReply) throw new Error('Transport response unavailable');}
        return original(command, args);
    });
    const open = async () => {
        const host = document.createElement('section'); document.body.append(host);
        const editor = new LLMWorkspaceEditor(host, {sessionId, assets, sessionManager: runtime.sessionManager, commandBus: runtime.commandBus,
            sessionRepository: runtime.sessionRepository, agentService: runtime.agentService});
        let closed = false; const close = async () => {if (!closed) {closed = true; await editor.destroy(); host.remove();}};
        cleanup.push(close); await editor.init(host);
        const input = (editor as unknown as {chatInput: ChatInput}).chatInput; await input.refreshCallTargets();
        return {host, editor, input, close};
    };
    return {runtime, sessionId, assets, original, open, counts: () => ({submitCalls, fileUploads}), allow: () => {loseReply = false;}};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type View = Awaited<ReturnType<Fixture['open']>>;
async function select(f: Fixture, view: View, file: File) {
    const catalog = await f.original<import('@itookit/llm-session/contracts').RootTargetCatalog>(SessionCommand.ListTargets);
    const target = catalog.entries.find(entry => entry.target.kind === 'flow' && entry.target.id === 'files')!.target;
    view.input.setConfig({target, agentId: ''}); view.input.restoreDraft('Inspect these files', [file], '');
}
async function send(view: View) {
    view.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog form')).not.toBeNull());
    document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    await vi.waitFor(() => expect(view.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
}
async function uncertain(f: Fixture, view: View) {
    await send(view);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords?.[0]).toMatchObject({status: 'unknown'}));
    return (await f.runtime.sessionRepository.getUIState(f.sessionId))!.operationRecords![0] as unknown as {context: {operationId: string}; input: {request: SubmissionRequest; draft: {token: string}}};
}
async function acceptAndRemove(f: Fixture, request: SubmissionRequest) {
    await f.original(SessionCommand.Bind, {sessionId: f.sessionId}); await (await f.runtime.kernel.kernel.openSession(f.sessionId)).suspend();
    await f.original(SessionCommand.Submit, request);
    const queue = await f.original<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await f.original(SessionCommand.EditInstructionQueue, {action: 'remove', id: request.submission!.id, expectedRevision: queue.revision});
}

it('reopens an unknown file submission, queries the original operation and consumes matching restored files without resending or uploading again', async () => {
    const f = await setup(), first = await f.open(), file = new File(['PRIVATE_FILE_BYTES'], 'notes.txt', {type: 'text/plain'});
    await select(f, first, file); const record = await uncertain(f, first); await first.close();
    const second = await f.open();
    expect(second.input.getDraftFiles()[0]).not.toBe(file); expect(draftFileId(second.input.getDraftFiles()[0])).toBe(draftFileId(file));
    expect(second.input.getConfig().draftToken).toBe(record.input.draft.token);
    await send(second); expect(f.counts()).toEqual({submitCalls: 1, fileUploads: 1}); await second.close();
    await acceptAndRemove(f, record.input.request);
    const third = await f.open();
    expect(JSON.parse(JSON.stringify(await captureSubmissionDraft(third.input.getConfig(), third.input.getDraftFiles())))).toEqual(record.input.draft);
    third.host.querySelector<HTMLButtonElement>('[data-call-reconcile]')!.click();
    await vi.waitFor(() => expect(third.input.getDraftFiles()).toEqual([]));
    expect(third.input.getConfig().text).toBe(''); expect(third.input.getConfig().input).toBeUndefined();
    expect(f.counts()).toEqual({submitCalls: 1, fileUploads: 1}); expect(await f.runtime.kernel.kernel.listSessionTasks(f.sessionId)).toEqual([]);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.branchDrafts?.main?.inputFiles).toEqual([]));
});

it('preserves newer text and same-name same-size replacement bytes when the original file operation is confirmed', async () => {
    const f = await setup(), first = await f.open(), original = new File(['OLD'], 'same.txt', {type: 'text/plain'});
    await select(f, first, original); const record = await uncertain(f, first);
    const replacement = new File(['NEW'], 'same.txt', {type: 'text/plain'});
    first.input.restoreDraftFiles([replacement]); first.input.setConfig({text: 'Keep newer input'}); await first.editor.flushPendingSave(); await first.close();
    await acceptAndRemove(f, record.input.request); const next = await f.open(), before = next.input.getConfig();
    next.host.querySelector<HTMLButtonElement>('[data-call-reconcile]')!.click();
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords?.[0]).toMatchObject({status: 'accepted'}));
    expect(next.input.getConfig()).toEqual(before); expect(new TextDecoder().decode(await fileBytes(next.input.getDraftFiles()[0]))).toBe('NEW');
    expect(draftFileId(next.input.getDraftFiles()[0])).not.toBe(draftFileId(original));
    expect(f.counts()).toEqual({submitCalls: 1, fileUploads: 1}); expect(await f.runtime.kernel.kernel.listSessionTasks(f.sessionId)).toEqual([]);
});

it('consumes a ghost attachment draft after acceptance was persisted but the cleared draft write was lost', async () => {
    const f = await setup(); f.allow();
    const view = await f.open(); await (await f.runtime.kernel.kernel.openSession(f.sessionId)).suspend(); await select(f, view, new File(['Accepted file'], 'accepted.txt', {type: 'text/plain'}));
    const write = f.runtime.sessionRepository.compareAndSetUIState!.bind(f.runtime.sessionRepository); let failClear = true;
    vi.spyOn(f.runtime.sessionRepository, 'compareAndSetUIState').mockImplementation(async (id, revision, state) => {
        if (failClear && state.branchDrafts?.main?.inputText === '' && state.branchDrafts.main.inputFiles?.length === 0)
            throw Object.assign(new Error('Lost draft-clear write'), {code: 'STORAGE_WRITE_FAILED'});
        return write(id, revision, state);
    });
    await send(view);
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords?.[0]).toMatchObject({status: 'accepted'}));
    expect(view.input.getDraftFiles()).toEqual([]); await expect(view.close()).rejects.toBeInstanceOf(AggregateError);
    failClear = false;
    const restored = await f.open(); expect(restored.input.getDraftFiles()).toEqual([]); expect(restored.input.getConfig().text).toBe('');
    expect(f.counts()).toEqual({submitCalls: 1, fileUploads: 1});
    expect((await f.original<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toHaveLength(1);
    expect(await f.runtime.kernel.kernel.listSessionTasks(f.sessionId)).toEqual([]);
});


it('retains input and does not dispatch when its durable attachment draft cannot be saved', async () => {
    const f = await setup(), view = await f.open(), file = new File(['Keep this file'], 'pending.txt', {type: 'text/plain'});
    await select(f, view, file);
    const write = f.assets.driver.createFile.bind(f.assets.driver); let fail = true;
    vi.spyOn(f.assets.driver, 'createFile').mockImplementation(async (...args) => {
        if (fail) throw Object.assign(new Error('Attachment storage is unavailable'), {code: 'STORAGE_WRITE_FAILED'});
        return write(...args);
    });
    await send(view);
    expect(f.counts().submitCalls).toBe(0); expect(view.input.getDraftFiles()).toEqual([file]);
    expect(view.input.getConfig().text).toBe('Inspect these files');
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords ?? []).toEqual([]);
    fail = false; await view.editor.flushPendingSave(); await view.close();
    const restored = await f.open(); expect(restored.input.getDraftFiles().map(file => file.name)).toEqual(['pending.txt']);
});

it('keeps both real workspaces frozen operations when they save and reconcile the same Session', async () => {
    const f = await setup(), a = await f.open();
    await select(f, a, new File(['A'], 'a.txt', {type: 'text/plain'}));
    await send(a); const b = await f.open(); b.input.restoreDraftFiles([]);
    await select(f, b, new File(['B'], 'b.txt', {type: 'text/plain'})); await send(b);
    const records = (await f.runtime.sessionRepository.getUIState(f.sessionId))!.operationRecords! as unknown as Array<{context: {operationId: string}; input: {request: SubmissionRequest}}>;
    expect(records).toHaveLength(2); expect(new Set(records.map(record => record.context.operationId)).size).toBe(2);
    for (const record of records) await acceptAndRemove(f, record.input.request);
    for (const view of [a, b]) {
        for (const button of view.host.querySelectorAll<HTMLButtonElement>('[data-call-reconcile]')) button.click();
        await vi.waitFor(() => expect(view.input.getDraftFiles()).toEqual([]));
    }
    const confirmed = (await f.runtime.sessionRepository.getUIState(f.sessionId))!.operationRecords! as unknown as Array<{status: string}>;
    expect(confirmed.map(record => record.status)).toEqual(['accepted', 'accepted']);
    expect(f.counts()).toEqual({submitCalls: 2, fileUploads: 2});
    a.host.querySelector<HTMLButtonElement>('[data-draft-resolve=load]')?.click();
    await vi.waitFor(() => expect(a.host.querySelector<HTMLElement>('[data-draft-recovery]')!.hidden).toBe(true));
    expect(await f.runtime.kernel.kernel.listSessionTasks(f.sessionId)).toEqual([]);
});

it('does not let an old accepted operation clear another workspace newer persistent draft', async () => {
    const f = await setup(), a = await f.open();
    await select(f, a, new File(['OLD'], 'same.txt', {type: 'text/plain'})); const record = await uncertain(f, a);
    const b = await f.open(); b.input.restoreDraftFiles([new File(['NEW'], 'same.txt', {type: 'text/plain'})]);
    b.input.setConfig({text: 'Keep the other workspace draft'}); await b.editor.flushPendingSave();
    const expected = structuredClone((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main);
    await acceptAndRemove(f, record.input.request);
    a.host.querySelector<HTMLButtonElement>('[data-call-reconcile]')?.click();
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.operationRecords![0]).toMatchObject({status: 'accepted'}));
    await vi.waitFor(() => expect(a.input.getDraftFiles()).toEqual([]));
    await a.editor.flushPendingSave().catch(() => {});
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main).toEqual(expected);
    expect(b.input.getConfig().text).toBe('Keep the other workspace draft'); expect(f.counts()).toEqual({submitCalls: 1, fileUploads: 1});
    expect(a.host.querySelector<HTMLElement>('[data-draft-recovery]')!.hidden).toBe(false);
    a.host.querySelector<HTMLButtonElement>('[data-draft-resolve=load]')!.click();
    await vi.waitFor(() => expect(a.input.getConfig().text).toBe('Keep the other workspace draft'));
    expect(new TextDecoder().decode(await fileBytes(a.input.getDraftFiles()[0]))).toBe('NEW');
    expect(f.counts()).toEqual({submitCalls: 1, fileUploads: 1});
    await a.close();
});


it('keeps conflicting local input and requires another explicit replacement if the saved draft advances again', async () => {
    const f = await setup(), a = await f.open(), b = await f.open();
    a.input.setConfig({text: 'Saved A'}); await a.editor.flushPendingSave();
    b.input.setConfig({text: 'Local B'}); await expect(b.editor.flushPendingSave()).rejects.toMatchObject({code: 'SESSION_DRAFT_CONFLICT'});
    expect(b.input.getConfig().text).toBe('Local B');
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main.inputText).toBe('Saved A');
    a.input.setConfig({text: 'Saved A advanced'}); await a.editor.flushPendingSave();
    b.host.querySelector<HTMLButtonElement>('[data-draft-resolve=replace]')!.click();
    await vi.waitFor(() => expect(b.host.querySelector('[data-draft-recovery]')!.textContent).toContain('Saved A advanced'));
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main.inputText).toBe('Saved A advanced');
    b.host.querySelector<HTMLButtonElement>('[data-draft-resolve=replace]')!.click();
    await vi.waitFor(() => expect(b.host.querySelector<HTMLElement>('[data-draft-recovery]')!.hidden).toBe(true));
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main.inputText).toBe('Local B');
    expect(f.counts()).toEqual({submitCalls: 0, fileUploads: 0});
});

it.each(['edit', 'hide'] as const)('preserves local input when %s happens while loading conflict attachments', async mode => {
    const f = await setup(), a = await f.open(), b = await f.open();
    await select(f, a, new File(['Saved bytes'], 'saved.txt', {type: 'text/plain'})); await a.editor.flushPendingSave();
    b.input.setConfig({text: 'Keep local'}); await expect(b.editor.flushPendingSave()).rejects.toHaveProperty('code', 'SESSION_DRAFT_CONFLICT');
    let release!: () => void, entered = false; const pending = new Promise<void>(resolve => {release = resolve;});
    const read = f.assets.driver.readContent.bind(f.assets.driver); let block = true;
    vi.spyOn(f.assets.driver, 'readContent').mockImplementation(async (...args) => {
        if (block && String(args[0]).startsWith('/draft-')) {entered = true; await pending;}
        return read(...args);
    });
    b.host.querySelector<HTMLButtonElement>('[data-draft-resolve=load]')!.click();
    await vi.waitFor(() => expect(entered).toBe(true));
    const text = mode === 'edit' ? 'New edit during file read' : 'Keep local';
    if (mode === 'edit') b.input.setConfig({text}); else b.editor.cancelPendingRender();
    block = false; release();
    await vi.waitFor(() => expect(b.host.querySelector<HTMLButtonElement>('[data-draft-resolve=replace]')!.disabled).toBe(false));
    expect(b.input.getConfig().text).toBe(text); expect(b.input.getDraftFiles()).toEqual([]);
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main.inputText).toBe('Inspect these files');
    if (mode === 'hide') await b.editor.activate();
    b.host.querySelector<HTMLButtonElement>('[data-draft-resolve=replace]')!.click();
    await vi.waitFor(() => expect(b.host.querySelector<HTMLElement>('[data-draft-recovery]')!.hidden).toBe(true));
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))!.branchDrafts!.main.inputText).toBe(text);
    expect(f.counts()).toEqual({submitCalls: 0, fileUploads: 0});
});

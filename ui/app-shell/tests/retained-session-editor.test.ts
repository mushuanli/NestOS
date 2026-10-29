// @vitest-environment jsdom
import {SessionCommand, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindLocalApplicationServices} from '@itookit/app-core/host';
import {IndependentSessionEditor} from '../../llm-ui-adapter/src/shell/IndependentSessionEditor';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});
async function fixture() {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const id = await runtime.sessionRepository.createSession('Retained chat');
    await runtime.sessionRepository.updateManifest(id, {branches: {main: null, review: null}});
    await runtime.sessionRepository.updateUIState(id, {branchDrafts: {main: {inputText: 'Main draft'}, review: {inputText: 'Review draft'}}});
    const services = bindLocalApplicationServices(runtime), root = document.createElement('div'); document.body.append(root);
    const released = vi.fn(), editor = new IndependentSessionEditor(root, {sessionId: id, target: {kind: 'session', sessionId: id, branch: 'main'},
        sessionRepository: services.sessionRepository, sessionManager: services.sessionManager, commandBus: services.commandBus, agentService: services.agentService,
        mountMoreMenu: host => {const button = document.createElement('button'); button.textContent = 'Host action'; host.append(button); return () => {released(); button.remove();};}});
    cleanup.push(() => editor.destroy()); await editor.init(root);
    await vi.waitFor(() => expect(root.querySelector<HTMLSelectElement>('.llm-chat__branch')!.options.length).toBe(2));
    const input = root.querySelector<HTMLTextAreaElement>('.llm-chat__input')!, history = root.querySelector('.llm-chat__history');
    const change = (branch: string) => {const select = root.querySelector<HTMLSelectElement>('.llm-chat__branch')!; select.value = branch; select.dispatchEvent(new Event('change'));};
    return {runtime, services, root, editor, id, input, history, released, change};
}
it('switches branch drafts through one ChatView and releases only the replaced host presentation', async () => {
    const f = await fixture(); expect(f.input.value).toBe('Main draft');
    expect(f.root.querySelector('.llm-chat__header [data-chat-settings]')).toBeNull();
    expect(f.root.querySelector('.llm-chat__input-menu [data-chat-settings]')).not.toBeNull();
    expect(f.root.querySelector('.llm-chat__input-menu .workspace-context')).not.toBeNull();
    expect(f.root.querySelector('.llm-chat__input-menu [data-selector-id=callMode]')).not.toBeNull();
    expect(f.root.querySelector('[data-selector-id=modelTier]')).toBeNull();
    expect(f.root.querySelector('[data-input-action=websearch]')).not.toBeNull();
    expect(f.root.querySelector('[data-input-action=help]')).not.toBeNull();
    f.editor.setText('Edited main draft'); await f.editor.flushPendingSave(); f.input.focus(); f.change('review');
    await vi.waitFor(() => expect(f.input.value).toBe('Review draft'));
    expect(f.root.querySelector('.llm-chat__input')).toBe(f.input); expect(f.root.querySelector('.llm-chat__history')).toBe(f.history);
    expect(document.activeElement).toBe(f.input); expect(f.released).toHaveBeenCalledOnce();
    expect(f.root.querySelectorAll('.llm-chat__branch')).toHaveLength(1); expect(f.root.querySelectorAll('.llm-chat__host-menu:not([data-chat-settings])')).toHaveLength(1);
    expect(f.root.querySelectorAll('.workspace-context')).toHaveLength(1); expect(f.root.querySelectorAll('.llm-session-runs')).toHaveLength(1);
    f.editor.setText('Edited review draft'); await f.editor.flushPendingSave(); f.change('main');
    await vi.waitFor(() => expect(f.input.value).toBe('Edited main draft'));
    expect(f.released).toHaveBeenCalledTimes(2);
    const state = await f.runtime.sessionRepository.getUIState(f.id);
    expect(state?.branchDrafts?.review?.inputText).toBe('Edited review draft');
    const drafts = state!.branchDrafts as Record<string, {inputView: {draft: {scopeId: string}}}>;
    expect(drafts.main.inputView.draft.scopeId).not.toBe(drafts.review.inputView.draft.scopeId);
});
it('saves later typing to the original branch while the backend branch switch is pending', async () => {
    const f = await fixture(), execute = f.services.commandBus.execute.bind(f.services.commandBus);
    let release!: () => void, switching = false;
    const gate = new Promise<void>(resolve => {release = resolve;});
    vi.spyOn(f.services.commandBus, 'execute').mockImplementation(async (name, args) => {
        if (name === 'vcs.branch.switch') {switching = true; await gate;}
        return execute(name, args);
    });
    f.change('review');
    try {await vi.waitFor(() => expect(switching).toBe(true)); f.editor.setText('Typed during switch');}
    finally {release();}
    await vi.waitFor(() => expect(f.input.value).toBe('Review draft'));
    expect((await f.runtime.sessionRepository.getUIState(f.id))?.branchDrafts?.main?.inputText).toBe('Typed during switch');
    expect(f.root.querySelector('.llm-chat__input')).toBe(f.input);
});
it('adopts an externally selected branch on activation without rebuilding the input', async () => {
    const f = await fixture(); f.editor.setText('Saved main'); f.editor.cancelPendingRender();
    await f.services.commandBus.execute('vcs.branch.switch', {branchName: 'review'}); await f.editor.activate();
    expect(f.input.value).toBe('Review draft'); expect(f.root.querySelector('.llm-chat__input')).toBe(f.input);
    expect((await f.runtime.sessionRepository.getUIState(f.id))?.branchDrafts?.main?.inputText).toBe('Saved main');
});
it('keeps the current branch and draft when the pre-switch conditional save fails', async () => {
    const f = await fixture(), execute = vi.spyOn(f.services.commandBus, 'execute');
    vi.spyOn(f.services.sessionRepository, 'compareAndSetUIState').mockRejectedValueOnce(Object.assign(new Error('DRAFT_STORE_UNAVAILABLE'), {code: 'EACCES'}));
    const failure = vi.fn(); f.editor.on('error', failure); f.editor.setText('Keep unsaved input'); f.change('review');
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(execute.mock.calls.some(([name]) => name === 'vcs.branch.switch')).toBe(false);
    expect((await f.runtime.sessionRepository.getManifest(f.id)).currentBranch).toBe('main');
    expect(f.input.value).toBe('Keep unsaved input'); expect(f.root.querySelector('.llm-chat__input')).toBe(f.input);
    await f.editor.flushPendingSave(); expect((await f.runtime.sessionRepository.getUIState(f.id))?.branchDrafts?.main?.inputText).toBe('Keep unsaved input');
});
it('restores edits made through the legacy editor instead of its stale structured draft mirror', async () => {
    const f = await fixture(); f.editor.setText('Structured draft'); await f.editor.flushPendingSave(); await f.editor.destroy();
    const before = (await f.runtime.sessionRepository.getUIState(f.id))!.branchDrafts!.main;
    await f.runtime.sessionRepository.updateUIState(f.id, {branchDrafts: {main: {...before, inputText: 'Edited through legacy UI'}}});
    const root = document.createElement('div'); document.body.append(root);
    const editor = new IndependentSessionEditor(root, {sessionId: f.id, target: {kind: 'session', sessionId: f.id, branch: 'main'},
        sessionRepository: f.services.sessionRepository, sessionManager: f.services.sessionManager,
        commandBus: f.services.commandBus, agentService: f.services.agentService});
    cleanup.push(() => editor.destroy()); await editor.init(root);
    expect(root.querySelector<HTMLTextAreaElement>('.llm-chat__input')!.value).toBe('Edited through legacy UI');
    await editor.flushPendingSave();
    expect((await f.runtime.sessionRepository.getUIState(f.id))?.branchDrafts?.main?.inputText).toBe('Edited through legacy UI');
});

it('opens a redeployed Session with the current Agent version and preserves the unsent draft', async () => {
    const f = await fixture(); await f.editor.destroy();
    const catalog = await f.services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const target = catalog.entries.find(entry => entry.target.kind === 'agent' && !entry.input)!.target;
    await f.runtime.sessionRepository.updateUIState(f.id, {branchDrafts: {main: {inputText: 'Unsent before deployment', inputTarget: {...target, version: 'before-deployment', digest: 'before-deployment'}}}});
    const root = document.createElement('div'); document.body.append(root);
    const editor = new IndependentSessionEditor(root, {sessionId: f.id, target: {kind: 'session', sessionId: f.id, branch: 'main'},
        sessionRepository: f.services.sessionRepository, sessionManager: f.services.sessionManager,
        commandBus: f.services.commandBus, agentService: f.services.agentService});
    cleanup.push(() => editor.destroy()); await editor.init(root);
    expect(root.querySelector<HTMLTextAreaElement>('.llm-chat__input')!.value).toBe('Unsent before deployment');
    const select = root.querySelector<HTMLSelectElement>('[data-call-target]')!;
    expect(JSON.parse(select.value)).toEqual([target.kind, target.id, target.version, target.digest]);
    expect(root.querySelector('.llm-chat__validation')!.textContent).toBe('');
    await editor.flushPendingSave();
    expect((await f.runtime.sessionRepository.getUIState(f.id))?.branchDrafts?.main?.inputText).toBe('Unsent before deployment');
});

it('refreshes an unconfirmed target when its catalog changes after opening, keeping input and operation identity intact', async () => {
    const f = await fixture(), execute = f.services.commandBus.execute.bind(f.services.commandBus);
    const catalog = await execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const select = f.root.querySelector<HTMLSelectElement>('[data-call-target]')!, selected = JSON.parse(select.value);
    const next = {...catalog, entries: catalog.entries.map(entry => entry.target.kind === selected[0] && entry.target.id === selected[1]
        ? {...entry, target: {...entry.target, version: 'after-refresh', digest: 'after-refresh'}} : entry)};
    const calls = vi.spyOn(f.services.commandBus, 'execute').mockImplementation(async (name, args) => name === SessionCommand.ListTargets ? next : execute(name, args));
    f.editor.setText('New unsent text'); f.input.focus();
    f.root.querySelector<HTMLButtonElement>('[data-chat-action=refresh]')!.click();
    await vi.waitFor(() => expect(JSON.parse(select.value)[2]).toBe('after-refresh'));
    expect(f.root.querySelector('.llm-chat__input')).toBe(f.input); expect(f.input.value).toBe('New unsent text'); expect(document.activeElement).toBe(f.input);
    expect(f.root.querySelector('.llm-chat__validation')!.textContent).toBe('');
    expect(calls.mock.calls.some(([name]) => name === SessionCommand.Submit || name === SessionCommand.Send)).toBe(false);
});

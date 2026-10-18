// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindApplicationBackend, bindLocalApplicationServices, createApplicationClient} from '@itookit/app-core/host';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';
import {OpenedViewProjection} from '../src/lifecycle/opened-view';
import {folderBrowserPath} from '@itookit/app-contracts';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {LLMWorkspaceEditor} from '../../llm-ui-adapter/src/shell/LLMWorkspaceEditor';
import {createLLMFactory} from '../../llm-ui-adapter/src/chat';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    Reflect.deleteProperty(Range.prototype, 'getClientRects'); Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');});
async function setup(observed = false) {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    Object.defineProperties(Range.prototype, {getClientRects: {configurable: true, value: () => []}, getBoundingClientRect: {configurable: true, value: () => new DOMRect()}});
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const projection = observed ? await observedApplication(bindLocalApplicationServices(runtime)) : undefined;
    const services = projection?.services ?? bindLocalApplicationServices(runtime), backend = projection?.backend ?? bindApplicationBackend(runtime);
    const factory = createLLMFactory(services.agentService, {sessionRepository: services.sessionRepository, sessionManager: services.sessionManager, commandBus: services.commandBus});
    const workbench = new SessionWorkbench({sidebar, container: main, backend, repository: services.sessionRepository,
        files: services.sessionFiles, projects: services.projects, kernel: services.kernel.kernel, factory, fileFactory: factory, onSelect() {}});
    cleanup.push(() => workbench.destroy()); await workbench.start();
    projection?.finishHydration();
    const project = await runtime.projects.personal(); await workbench.startSessionDraft(folderBrowserPath(project.path));
    return {runtime, workbench, main, project};
}
async function observedApplication(services: Parameters<typeof createApplicationClient>[0]) {
    const application = createApplicationClient(services); cleanup.push(() => application.close());
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);});
    cleanup.push(() => server.close(), () => client.close());
    const boot = await server.bootstrap(application); client.applyUpdates(boot.updates);
    const remote = client.decode(boot.value!);
    const view = await remote.backend.openView({documents: [], workbench: {chatControls: true, initialNavigation: false}});
    const projection = new OpenedViewProjection(view, remote.services, remote.backend); await projection.start();
    cleanup.push(() => projection.dispose()); return projection;
}
async function configureModel(runtime: Awaited<ReturnType<typeof createApplicationRuntime>>) {
    await runtime.agentService.saveProvider({id: 'test', name: 'Test', implementation: 'openai-compatible', apiKey: 'test',
        baseURL: 'http://model.invalid', models: [{id: 'test-model', name: 'Test'}]});
    await runtime.agentService.saveConnection({id: 'test', name: 'Test', providerId: 'test', tiers: {standard: 'test-model'}});
    await runtime.agentService.setDefaultConnection('test');
}
it('promotes a local UUID in place and leaves later typing, focus and sibling tabs intact', async () => {
    const f = await setup(), shell = f.workbench as any, tab = shell.tabs.current, wrapper = shell.editor;
    const composer = await f.runtime.projects.drafts.open(f.project.project.id, await f.runtime.projects.sessionFolder(f.project));
    const mount = tab.panel.querySelector('.session-editor-mount'), textarea = mount.querySelector('.llm-input__textarea'), history = mount.querySelector('#llm-ui-history');
    wrapper.setText('First message'); textarea.focus(); textarea.setSelectionRange(2, 2);
    let finish!: () => void;
    const delayed = new Promise<void>(resolve => {finish = resolve;});
    acceptSubmission(f, delayed);
    const sending = wrapper.commands.sendMessage({text: 'First message', files: [], agentId: 'default'});
    await vi.waitFor(() => expect(f.runtime.commandBus.execute).toHaveBeenCalledWith(SessionCommand.Send, expect.anything()));
    wrapper.setText('Next message');
    textarea.focus(); textarea.setSelectionRange(3, 3); finish(); await sending;
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toContain(composer.id));
    expect(shell.editor).toBe(wrapper); expect(shell.tabs.current).toBe(tab); expect(tab.panel.querySelector('.session-editor-mount')).toBe(mount);
    expect(mount.querySelector('.llm-input__textarea')).toBe(textarea); expect(mount.querySelector('#llm-ui-history')).toBe(history);
    expect(textarea.value).toBe('Next message'); expect(document.activeElement).toBe(textarea); expect(textarea.selectionStart).toBe(3);
    expect(tab.conversationId).toBe(composer.id); expect(mount.querySelector('.llm-draft-scope')).toBeNull();
    expect(mount.querySelector('.llm-input__execution-picker').hidden).toBe(true);
    expect((await f.runtime.projects.drafts.open(f.project.project.id, await f.runtime.projects.sessionFolder(f.project))).id).not.toBe(composer.id);
    await f.workbench.startSessionDraft(folderBrowserPath(f.project.path));
    expect(shell.tabs.current).not.toBe(tab); expect(shell.tabs.get(tab.id)).toBe(tab);
});

it('shows actual kernel replies through the host observation and RPC after creating a draft, without reopening', async () => {
    const f = await setup(true), shell = f.workbench as any, editor = shell.editor;
    await configureModel(f.runtime);
    const fetcher = vi.fn(async () => new Response('data: ' + JSON.stringify({id: 'reply', model: 'test-model',
        choices: [{index: 0, delta: {role: 'assistant', content: 'Real kernel response'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}) + '\n\ndata: [DONE]\n\n',
        {headers: {'content-type': 'text/event-stream'}}));
    vi.stubGlobal('fetch', fetcher);
    const history = shell.tabs.current.panel.querySelector('#llm-ui-history');
    editor.setText('Real first question');
    await editor.commands.sendMessage({text: 'Real first question', files: [], agentId: 'default',
        overrides: {executionMode: 'chat', streamMode: true, webSearchEnabled: false}});
    await vi.waitFor(() => {
        expect(history.textContent).toContain('Real first question');
        expect(history.textContent).toContain('Real kernel response');
    }, {timeout: 10000});
    expect(fetcher).toHaveBeenCalledOnce();
    expect(shell.tabs.current.panel.querySelector('#llm-ui-history')).toBe(history);
});

function acceptSubmission(f: Awaited<ReturnType<typeof setup>>, wait = Promise.resolve()): void {
    const execute = f.runtime.commandBus.execute.bind(f.runtime.commandBus);
    vi.spyOn(f.runtime.commandBus, 'execute').mockImplementation(async (command: string, args?: any) => {
        if (command !== SessionCommand.Send) return execute(command, args);
        await wait;
        const submission = args.sendIntent.submission, id = submission.source.id;
        await f.runtime.sessionRepository.writeDocument(id, `round-${submission.id}.json`, JSON.stringify({id: submission.id, sessionId: id, submission,
            input: [{role: 'user', content: args.text}], output: [], executions: [{taskId: 'accepted-task', role: 'primary'}], historyParentIds: []}));
        await f.runtime.sessionRepository.updateManifest(id, {rootRoundId: submission.id, currentHead: submission.id, branches: {main: submission.id}});
        await f.runtime.projects.drafts.reconcile(f.project.project.id); return 'accepted-task';
    });
}

it('keeps project navigation stable while a real kernel response streams', async () => {
    const f = await setup(), shell = f.workbench as any, editor = shell.editor;
    await configureModel(f.runtime);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new ReadableStream<Uint8Array>({start(controller) {stream = controller;}});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(response, {headers: {'content-type': 'text/event-stream'}})));
    const emit = (content: string) => stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({id: 'reply', model: 'test-model',
        choices: [{index: 0, delta: {content}, finish_reason: null}]}) + '\n\n'));
    editor.setText('Stable navigation');
    const changes = vi.spyOn(shell, 'refreshView');
    try {
        await editor.commands.sendMessage({text: 'Stable navigation', files: [], agentId: 'default',
            overrides: {executionMode: 'chat', streamMode: true, webSearchEnabled: false}});
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); emit('First');
        await vi.waitFor(() => expect(shell.tabs.current.panel.textContent).toContain('First'));
        await new Promise(resolve => setTimeout(resolve, 400)); changes.mockClear();
        for (let index = 0; index < 5; index++) {emit(` token${index}`); await new Promise(resolve => setTimeout(resolve, 170));}
        expect(changes.mock.calls.map(([sources]) => sources)).toEqual([]);
    } finally {stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); stream.close();}
    await vi.waitFor(() => expect(shell.tabs.current.panel.textContent).toContain('token4'));
    await vi.waitFor(() => expect(f.runtime.sessionManager.getStatus()).toBe('completed'));
    await vi.waitFor(() => expect(changes).toHaveBeenCalled());
});

it('rolls back a failed controller initialization without replacing the composer and retries the same UUID', async () => {
    const f = await setup(), shell = f.workbench as any, tab = shell.tabs.current, wrapper = shell.editor;
    const mount = tab.panel.querySelector('.session-editor-mount'), textarea = mount.querySelector('.llm-input__textarea');
    const uuid = tab.conversationId;
    wrapper.setText('Retain after initialization failure');
    vi.spyOn(LLMWorkspaceEditor.prototype as any, 'initCommands').mockImplementationOnce(() => {throw new Error('Initialization failed');});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await wrapper.commands.sendMessage({text: textarea.value, files: [], agentId: 'default'})).toBe(false);
    expect(shell.editor).toBe(wrapper); expect(mount.querySelector('.llm-input__textarea')).toBe(textarea);
    expect(textarea.value).toBe('Retain after initialization failure'); expect(tab.conversationId).toBe(uuid);
    expect(mount.querySelector('.llm-draft-scope')).not.toBeNull();
    acceptSubmission(f);
    await wrapper.commands.sendMessage({text: textarea.value, files: [], agentId: 'default'});
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toContain(uuid));
    expect(mount.querySelector('.llm-input__textarea')).toBe(textarea);
});

it('promotes a hidden draft without switching away from the newly selected project draft', async () => {
    const f = await setup(), shell = f.workbench as any, tab = shell.tabs.current, wrapper = shell.editor;
    const uuid = tab.conversationId, other = await f.runtime.projects.create('Other project');
    wrapper.setText('First project content');
    let finish!: () => void;
    acceptSubmission(f, new Promise<void>(resolve => {finish = resolve;}));
    const sending = wrapper.commands.sendMessage({text: 'First project content', files: [], agentId: 'default'});
    await vi.waitFor(() => expect(f.runtime.commandBus.execute).toHaveBeenCalledWith(SessionCommand.Send, expect.anything()));
    await f.workbench.startSessionDraft(folderBrowserPath(other.path));
    const selected = shell.tabs.current, selectedEditor = shell.editor, selectedRoute = f.workbench.getActiveResourceId();
    try {finish(); await sending;} finally {finish();}
    await vi.waitFor(() => expect(tab.id).toBe(uuid));
    expect(shell.tabs.current).toBe(selected); expect(shell.editor).toBe(selectedEditor);
    expect(f.workbench.getActiveResourceId()).toBe(selectedRoute);
    expect((await f.runtime.projects.drafts.open(other.project.id, await f.runtime.projects.sessionFolder(other))).id).toBe(selected.conversationId);
});

it('keeps one independent UUID and composer per project when switching projects or selecting the launch agent', async () => {
    const f = await setup(), shell = f.workbench as any, first = shell.tabs.current, editor = shell.editor;
    editor.setText('First project draft');
    const other = await f.runtime.projects.create('Second project');
    await f.workbench.startSessionDraft(folderBrowserPath(other.path), undefined, 'default');
    const second = shell.tabs.current, secondEditor = shell.editor;
    secondEditor.setText('Second project draft');
    expect(second.conversationId).not.toBe(first.conversationId);
    await f.workbench.startSessionDraft(folderBrowserPath(f.project.path), undefined, 'default');
    expect(shell.tabs.current).toBe(first); expect(shell.editor).toBe(editor);
    expect(first.panel.querySelector('.llm-input__textarea').value).toBe('First project draft');
    await f.workbench.startSessionDraft(folderBrowserPath(other.path), undefined, 'default');
    expect(shell.tabs.current).toBe(second); expect(shell.editor).toBe(secondEditor);
    expect(second.panel.querySelector('.llm-input__textarea').value).toBe('Second project draft');
    expect(await f.runtime.sessionRepository.list()).toHaveLength(0);
});

it('tracks the replacement draft UUID after discard and promotes the replacement in place', async () => {
    const f = await setup(), shell = f.workbench as any, tab = shell.tabs.current, editor = shell.editor;
    const old = tab.conversationId;
    editor.setText('Discard this draft');
    await editor.discard();
    expect(tab.conversationId).not.toBe(old);
    const uuid = tab.conversationId;
    editor.setText('Send the replacement'); acceptSubmission(f);
    await editor.commands.sendMessage({text: 'Send the replacement', files: [], agentId: 'default'});
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toContain(uuid));
    expect(shell.tabs.current).toBe(tab); expect(shell.editor).toBe(editor);
});

it('adopts a draft accepted by another view without submitting it again or replacing the current input', async () => {
    const f = await setup(), shell = f.workbench as any, tab = shell.tabs.current, editor = shell.editor;
    const textarea = tab.panel.querySelector('.llm-input__textarea'), uuid = tab.conversationId;
    editor.setText('Local unsent edits'); textarea.focus(); textarea.setSelectionRange(5, 5);
    await editor.flushPendingSave();
    const remoteCursor = await f.runtime.projects.drafts.open(f.project.project.id, await f.runtime.projects.sessionFolder(f.project));
    const prepared = await remoteCursor.prepare();
    acceptSubmission(f);
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Submitted from another view', sendIntent: {submission: prepared.submission}});
    await vi.waitFor(() => expect(editor.delegate).toBeDefined());
    expect(f.workbench.getActiveResourceId()).toContain(uuid); expect(shell.tabs.current).toBe(tab); expect(shell.editor).toBe(editor);
    expect(tab.panel.querySelector('.llm-input__textarea')).toBe(textarea); expect(textarea.value).toBe('Local unsent edits');
    expect(textarea.selectionStart).toBe(5); expect(document.activeElement).toBe(textarea);
    expect(vi.mocked(f.runtime.commandBus.execute).mock.calls.filter(([command]) => command === SessionCommand.Send)).toHaveLength(1);
});

it('shows the first user bubble and later assistant events in the attached history after controller handoff', async () => {
    const f = await setup(), shell = f.workbench as any, editor = shell.editor;
    const mount = shell.tabs.current.panel.querySelector('.session-editor-mount'), history = mount.querySelector('#llm-ui-history');
    const subscribe = f.runtime.sessionManager.onEvent.bind(f.runtime.sessionManager);
    let deliver!: Parameters<typeof subscribe>[0];
    vi.spyOn(f.runtime.sessionManager, 'onEvent').mockImplementation(listener => {deliver = listener; return subscribe(listener);});
    let finish!: () => void;
    acceptSubmission(f, new Promise<void>(resolve => {finish = resolve;}));
    editor.setText('Visible first prompt');
    const sending = editor.commands.sendMessage({text: 'Visible first prompt', files: [], agentId: 'default'});
    try {
        await vi.waitFor(() => expect(f.runtime.commandBus.execute).toHaveBeenCalledWith(SessionCommand.Send, expect.anything()));
        expect(history.textContent).toContain('Visible first prompt');
    } finally {finish(); await sending;}
    const submission = vi.mocked(f.runtime.commandBus.execute).mock.calls.find(([command]) => command === SessionCommand.Send)![1] as any;
    const roundId = submission.sendIntent.submission.id;
    deliver({type: 'message:appended', payload: {sessionGroup: {id: `round-${roundId}-user`, role: 'user',
        content: 'Visible first prompt', timestamp: Date.now()}}} as never);
    const responseId = `round-${roundId}-output`;
    deliver({type: 'message:appended', payload: {isExecutionRoot: true, sessionGroup: {id: `round-${roundId}-assistant`,
        role: 'assistant', timestamp: Date.now(), executionRoot: {id: responseId, executorId: 'default', executorType: 'agent',
            name: 'Assistant', status: 'running', startTime: Date.now(), data: {output: ''}}}}} as never);
    deliver({type: 'message:updated', payload: {messageId: responseId, content: 'Visible streamed reply', field: 'output'}} as never);
    await vi.waitFor(() => {
        expect(history.textContent).toContain('Visible first prompt');
        expect(history.textContent).toContain('Visible streamed reply');
    });
    expect(mount.querySelector('#llm-ui-history')).toBe(history);
});

it('carries valid input preferences through the project picker without moving either project text or attachments', async () => {
    const f = await setup(), shell = f.workbench as any, source = shell.editor;
    const connection = {id: 'carry', name: 'Portable connection', providerId: 'provider', model: 'chat', tiers: {optimal: 'chat', fast: 'fast'},
        hasApiKey: true, credentialsReady: true};
    vi.spyOn(f.runtime.agentService, 'listAgents').mockReturnValue([{id: 'default', name: 'Default', config: {}}, {id: 'writer', name: 'Writer', config: {}}] as never);
    vi.spyOn(f.runtime.agentService, 'getConnections').mockResolvedValue([connection] as never);
    vi.spyOn(f.runtime.agentService, 'getDefaultConnection').mockResolvedValue(connection as never);
    vi.spyOn(f.runtime.agentService, 'getProvider').mockReturnValue({id: 'provider', name: 'Provider', enabled: true,
        models: [{id: 'chat', name: 'Chat'}, {id: 'fast', name: 'Fast'}]} as never);
    const other = await f.runtime.projects.create('Target project');
    await f.workbench.startSessionDraft(folderBrowserPath(other.path));
    const target = shell.editor;
    await target.commands.appendDraft({text: 'Target content', files: [new File(['Target attachment'], 'target.txt', {type: 'text/plain'})]});
    const targetId = shell.tabs.current.conversationId;
    await f.workbench.startSessionDraft(folderBrowserPath(f.project.path));
    source.input.setConfig({agentId: 'writer', settings: {connectionId: 'carry', modelTier: 'fast', executionMode: 'agent', reasoningEffort: 'high'}});
    source.setText('Source content');
    const select = shell.tabs.current.panel.querySelector('.llm-draft-scope select');
    await vi.waitFor(() => expect([...select.options].some((option: any) => option.value === other.project.id)).toBe(true));
    select.value = other.project.id; select.dispatchEvent(new Event('change', {bubbles: true}));
    await vi.waitFor(() => expect(target.input.getConfig()).toMatchObject({text: 'Target content', agentId: 'writer',
        settings: {connectionId: 'carry', modelTier: 'fast', executionMode: 'agent', reasoningEffort: 'high'}}));
    expect(shell.editor).toBe(target); expect(shell.tabs.current.conversationId).toBe(targetId);
    const composer = await f.runtime.projects.drafts.open(other.project.id, await f.runtime.projects.sessionFolder(other));
    const saved = JSON.parse(composer.initialData);
    expect(saved.config.text).toBe('Target content'); expect(saved.config.settings.connectionId).toBe('carry');
    expect(saved.files.map((file: any) => file.name)).toEqual(['target.txt']);
    expect(source.input.getConfig().text).toBe('Source content');
});

it('adopts the authoritative execution mode on external promotion while preserving local text', async () => {
    const f = await setup(), shell = f.workbench as any, editor = shell.editor;
    editor.setText('Unsent local draft'); await editor.flushPendingSave();
    expect(editor.input.getConfig().settings.executionMode ?? 'chat').toBe('chat');
    const cursor = await f.runtime.projects.drafts.open(f.project.project.id, await f.runtime.projects.sessionFolder(f.project));
    const prepared = await cursor.prepare();
    await f.runtime.sessionRepository.saveSessionSettings(prepared.sessionId, {executionMode: 'agent', executionModeLocked: true});
    acceptSubmission(f);
    await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'External agent run', sendIntent: {submission: prepared.submission}});
    await vi.waitFor(() => expect(editor.delegate).toBeDefined());
    expect((await f.runtime.sessionRepository.getSessionSettings(prepared.sessionId)).executionMode).toBe('agent');
    expect(editor.input.getConfig().settings.executionMode).toBe('agent');
});

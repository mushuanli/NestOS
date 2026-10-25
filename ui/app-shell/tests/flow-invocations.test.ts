// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {FlowsEditor} from '../../llm-ui-adapter/src/components/FlowsEditor';
import {SessionRepository, ContentTransferService, SessionDirectoryStorageResolver} from '@itookit/llm-session';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {StateService} from '../../llm-ui-adapter/src/services/StateService';
import {Toast} from '@itookit/ui-common';
import type {DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { CommandBus, FlowEngine, FlowDefinitionStore, DagCommandService, FlowInvocationService, FlowCommand, SessionCommand, createBuiltinDagPluginRegistry, registerDurablePrograms } from '@itookit/llm-session';
import { invokeFlowText } from '../../llm-ui-adapter/src/flows/invoke-flow';
import { InvocationPanel } from '../../llm-ui-adapter/src/flows/InvocationPanel';
import { SlashCommandPlugin } from '../../llm-ui-adapter/src/components/input/plugins/SlashCommandPlugin';
import { ChatInput } from '../../llm-ui-adapter/src/components/input/ChatInputView';
import { t } from '@itookit/common';
import {FlowInvocationCommand, type FlowInvocationRecord} from '@itookit/llm-session/contracts';

let repository: SessionRepository;
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, commands: CommandBus, panel: InvocationPanel;
beforeEach(async () => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    const engine = new FlowEngine(await manager.openFileSystem('/flows')); await engine.init();
    const plugins = createBuiltinDagPluginRegistry(), store = new FlowDefinitionStore(engine, plugins);
    const draft = await store.createDraft({ id: 'review', name: 'Review' });
    await store.saveDraft({ ...draft, parameters: [{ name: 'text', type: 'string', required: true, inputSource: 'composer.text' }], nodes: [
        { id: 'ask' as never, name: 'Ask', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {}, config: { requestId: 'same', prompt: '${param.text}' } },
    ] }, draft.draftVersion);
    commands = new CommandBus();
    commands.register(SessionCommand.GetConnections, async () => ({ connections: [] }));
    commands.register(SessionCommand.CheckFlowConnections, async () => ({valid: true}));
    new DagCommandService({ kernel, plugins, flowStore: store }).register(commands);
    const sessionFiles = await manager.openFileSystem('/session-data');
    repository = new SessionRepository(sessionFiles); await repository.init(); await repository.ensureSession('s', 'Parent');
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(sessionFiles));
    const transfers = new ContentTransferService({kernel, repository, commands});
    new FlowInvocationService(kernel, store, commands, undefined, undefined, undefined, undefined, undefined, transfers).register();
});
afterEach(async () => {
    panel?.destroy(); await kernel.closeSession('s', true); kernel.dispose(); await kernel.waitIdle();
    await repository.dispose(); await manager.dispose(); document.body.innerHTML = ''; vi.restoreAllMocks();
});
const submit = () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

it('shows resolved arguments and starts a separate linked Invocation when the user runs them again', async () => {
    const draft = await commands.execute<any>(FlowCommand.DraftLoad, {id: 'review'});
    const {revision} = await commands.execute<any>(FlowCommand.RevisionCreate, {draftId: 'review', expectedDraftVersion: draft.draftVersion});
    const call = await commands.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, {sessionId: 's', requestId: 'composer',
        flowId: revision.id, revision: revision.revision, parameters: {}, source: {kind: 'composer', text: 'Resolved request', attachments: [], values: {}}});
    expect(call.parameters).toEqual({});
    panel = new InvocationPanel(commands, 's', document.body, vi.fn());
    await vi.waitFor(async () => {await panel.refresh(); expect(document.querySelector('[data-invocation="composer"] details pre')?.textContent).toContain('Resolved request');});
    await vi.waitFor(async () => {await panel.refresh(); expect(document.querySelector('[data-invocation="composer"] [data-interaction-action="reply"]')).not.toBeNull();});
    document.querySelector<HTMLTextAreaElement>('[data-invocation="composer"] textarea')!.value = 'Done';
    document.querySelector<HTMLButtonElement>('[data-invocation="composer"] [data-interaction-action="reply"]')!.click();
    await vi.waitFor(async () => {await panel.refresh(); expect(document.querySelector('[data-invocation="composer"] [data-status]')?.textContent).toBe(t('flow.invoke.succeeded'));});
    const repeat = [...document.querySelectorAll<HTMLButtonElement>('[data-invocation="composer"] [data-actions] button')]
        .find(button => button.textContent === t('flow.invoke.repeat'))!;
    repeat.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('dialog [data-parameter="0"]')?.value).toBe('Resolved request'));
    submit();
    let calls: FlowInvocationRecord[] = [];
    await vi.waitFor(async () => {calls = await commands.execute(FlowInvocationCommand.List, {sessionId: 's'}); expect(calls).toHaveLength(2);});
    const next = calls.find(record => record.requestId !== call.requestId)!;
    expect(next.invocationId).not.toBe(call.invocationId); expect(next.rootTaskId).not.toBe(call.rootTaskId);
    expect(next.retryOfInvocationId).toBe(call.invocationId); expect(next.retryOfSessionId).toBe('s');
    expect((await (await kernel.openTask(call.rootTaskId!)).status()).task.status).toBe('succeeded');
    await panel.refresh(); expect(document.querySelector(`[data-invocation-id="${next.invocationId}"]`)).not.toBeNull();
});

it('calls a Flow twice through the input form, restores both cards, and routes replies independently', async () => {
    for (const text of ['First', 'Second']) {
        const pending = invokeFlowText(commands, 's', `review ${JSON.stringify({ text })}`);
        await vi.waitFor(() => expect(document.querySelector('dialog textarea')?.textContent).toBe(text));
        submit(); expect(await pending).toBe(true);
    }
    panel = new InvocationPanel(commands, 's', document.body, vi.fn());
    await vi.waitFor(async () => { await panel.refresh(); expect(document.querySelectorAll('.llm-input__interaction')).toHaveLength(2); });
    const cards = [...document.querySelectorAll<HTMLElement>('[data-invocation]')]; expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('First'); expect(cards[1].textContent).toContain('Second');
    const textarea = cards[0].querySelector('textarea')!; textarea.value = 'Reply one';
    cards[0].querySelector<HTMLButtonElement>('[data-interaction-action="reply"]')!.click();
    await vi.waitFor(async () => { await panel.refresh(); expect(cards[0].querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.succeeded')); });
    expect(cards[1].querySelector('.llm-input__interaction')).not.toBeNull();
    panel.destroy(); panel = new InvocationPanel(commands, 's', document.body, vi.fn());
    await vi.waitFor(async () => { await panel.refresh(); expect(document.querySelectorAll('[data-invocation]')).toHaveLength(2); expect(document.querySelectorAll('.llm-input__interaction')).toHaveLength(1); });
});

it('confirms Kernel tree stoppage before showing resume and preserves an answer submitted during pause', async () => {
    const pending = invokeFlowText(commands, 's', 'review {"text":"Pause interaction"}');
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull()); submit(); await pending;
    const [call] = await commands.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, {sessionId: 's'});
    panel = new InvocationPanel(commands, 's', document.body, vi.fn());
    const button = (key: Parameters<typeof t>[0]) => [...document.querySelectorAll<HTMLButtonElement>('[data-actions] button')].find(button => button.textContent === t(key));
    await vi.waitFor(async () => {await panel.refresh(); expect(document.querySelector('[data-interaction-action="reply"]')).not.toBeNull();});
    button('flow.invoke.pause')!.click();
    await vi.waitFor(async () => {await panel.refresh(); expect(button('flow.invoke.continue')).toBeDefined();});
    const stat = await (await kernel.openTask(call.rootTaskId!)).stat();
    expect(stat.control).toMatchObject({requested: 'pause', acknowledged: true}); expect(stat.stopped).toBe(true); expect(stat.settled).toBe(false);
    document.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Saved while paused';
    document.querySelector<HTMLButtonElement>('[data-interaction-action="reply"]')!.click();
    await vi.waitFor(async () => {
        const state = await commands.execute<any>(FlowCommand.RunGet, {sessionId: 's', taskId: call.rootTaskId});
        expect(state.taskTree.some((task: any) => Object.values(task.interactions).some((request: any) => request.status === 'resolved'))).toBe(true);
    });
    expect((await (await kernel.openTask(call.rootTaskId!)).stat()).stopped).toBe(true);
    button('flow.invoke.continue')!.click();
    await vi.waitFor(async () => {await panel.refresh(); expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.invoke.succeeded'));});
});

it('does not launch on cancellation and preserves slash text on a rejected call', async () => {
    const pending = invokeFlowText(commands, 's', 'review');
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); expect(await pending).toBe(false);
    expect(await commands.execute(FlowCommand.RunList, { sessionId: 's' })).toEqual([]);
    const setText = vi.fn(), plugin = new SlashCommandPlugin({ onFlow: async () => false } as never);
    plugin.activate({ setText, focus: vi.fn(), getText: () => '/flow review' } as never);
    expect(plugin.onBeforeSend('/flow review')).toBe(false);
    await Promise.resolve(); expect(setText).not.toHaveBeenCalled(); plugin.deactivate();
});

it('accepts a slash Flow during chat generation without submitting a second ordinary message or losing a new draft', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const onSend = vi.fn(), onFlow = vi.fn<() => Promise<boolean>>();
    let finish!: (value: boolean) => void;
    onFlow.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const input = new ChatInput(container, { onSend, onStop: vi.fn() });
    input.registerPlugin(new SlashCommandPlugin({ onFlow } as never));
    try {
        input.setLoading(true); input.setConfig({ text: 'ordinary draft' });
        const textarea = container.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        expect(textarea.disabled).toBe(false);
        expect(container.querySelector('.llm-input__field-wrapper--disabled')).toBeNull();
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onSend).not.toHaveBeenCalled(); expect(input.getConfig().text).toBe('ordinary draft');
        input.setConfig({ text: '/flow review' });
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => expect(onFlow).toHaveBeenCalledExactlyOnceWith('review'));
        input.setConfig({ text: 'new draft while starting' }); finish(true);
        await Promise.resolve(); await Promise.resolve();
        expect(input.getConfig().text).toBe('new draft while starting'); expect(onSend).not.toHaveBeenCalled();
    } finally { input.destroy(); }
});

it.each(['resume', 'cancel'] as const)('recovers a persisted lost pause receipt and %s without affecting another invocation', async action => {
    vi.spyOn(Toast, 'error').mockImplementation(() => {});
    const fs = await manager.openFileSystem('/session-data');
    let repository = new SessionRepository(fs); await repository.init(); await repository.ensureSession('s', 'Controls');
    const draft = await commands.execute<any>(FlowCommand.DraftLoad, {id: 'review'});
    const {revision} = await commands.execute<any>(FlowCommand.RevisionCreate, {draftId: 'review', expectedDraftVersion: draft.draftVersion});
    const invoke = (requestId: string) => commands.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke,
        {sessionId: 's', requestId, flowId: revision.id, revision: revision.revision, parameters: {text: requestId}});
    const first = await invoke('controlled'), other = await invoke('independent');
    const read = (call: FlowInvocationRecord) => commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: 's', taskId: call.rootTaskId});
    await vi.waitFor(async () => expect((await read(first)).nodes[0]?.snapshot.task.interactions.same?.status).toBe('pending'));
    let losePauseReply = true;
    const execute = vi.fn(async (name: string, args?: unknown) => {
        const result = await commands.execute(name, args);
        if (name === FlowCommand.RunGoalUpdate && losePauseReply) {losePauseReply = false; throw new Error('Lost pause response');}
        return result;
    });
    const root = document.createElement('div'); document.body.append(root);
    let editor = new FlowsEditor({commands: {execute} as never, sessionRepository: repository});
    try {
        await editor.init(root); await (editor as any).workbench.openRun(first.rootTaskId, 's');
        root.querySelector<HTMLButtonElement>('[data-run-control="pause"]')!.click();
        await vi.waitFor(async () => expect((await repository.getUIState('s'))?.operationRecords?.[0]?.status).toBe('unknown'));
        const saved = (await repository.getUIState('s'))!.operationRecords![0];
        const operationId = (saved.context as {operationId: string}).operationId;
        await editor.destroy(); await repository.dispose();
        repository = new SessionRepository(fs); await repository.init();
        editor = new FlowsEditor({commands: {execute} as never, sessionRepository: repository});
        await editor.init(root); await (editor as any).workbench.openRun(first.rootTaskId, 's');
        root.querySelector<HTMLButtonElement>(`[data-run-control="receipt:${operationId}"]`)!.click();
        await vi.waitFor(async () => expect((await repository.getUIState('s'))?.operationRecords?.[0]?.status).toBe('accepted'));
        expect(execute.mock.calls.filter(([name]) => name === FlowCommand.RunGoalUpdate)).toHaveLength(1);
        const respond = async (call: FlowInvocationRecord) => {
            const state = await read(call);
            await commands.execute(FlowCommand.RunRespond, {taskId: call.rootTaskId,
                targetTaskId: state.nodes[0].snapshot.task.id, requestId: 'same', value: 'Saved answer'});
        };
        await respond(other);
        await vi.waitFor(async () => expect((await read(other)).root.task.status).toBe('succeeded'));
        await respond(first);
        await vi.waitFor(async () => expect((await (await kernel.openTask(first.rootTaskId!)).stat()).stopped).toBe(true));
        expect((await read(first)).root.task.exit).toBeUndefined();
        await (editor as any).workbench.openRun(first.rootTaskId, 's');
        root.querySelector<HTMLButtonElement>(action === 'resume' ? '[data-run-control="resume"]' : '[data-run-action="cancel"]')!.click();
        await vi.waitFor(async () => expect((await read(first)).root.task.status).toBe(action === 'resume' ? 'succeeded' : 'cancelled'));
        expect((await read(other)).root.task.status).toBe('succeeded');
        expect(await commands.execute(FlowInvocationCommand.List, {sessionId: 's'})).toHaveLength(2);
        const receipt = await commands.execute<any>(FlowCommand.RunControlReceipt, {sessionId: 's', taskId: first.rootTaskId, requestId: operationId});
        expect(receipt).toMatchObject({requestId: operationId, action: 'pause', accepted: {requestId: operationId}});
    } finally {await editor.destroy(); await repository.dispose(); root.remove();}
}, 15000);

it('controls, answers and opens routed child invocations from the parent card using frozen execution identities', async () => {
    const draft = await commands.execute<any>(FlowCommand.DraftLoad, {id: 'review'});
    const {revision} = await commands.execute<any>(FlowCommand.RevisionCreate, {draftId: 'review', expectedDraftVersion: draft.draftVersion});
    const invoke = (requestId: string) => commands.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke,
        {sessionId: 's', requestId, execution: 'child', flowId: revision.id, revision: revision.revision, parameters: {text: requestId}});
    const first = await invoke('child-first'), second = await invoke('child-second'), openChild = vi.fn();
    const state = new StateService(repository), ledger = async () => createOperationLedger({
        initial: (await state.loadUIState('s'))?.operations, save: records => state.saveOperations('s', records)});
    let lost = false;
    const execute = vi.fn(async (name: string, args?: any) => {
        const result = await commands.execute(name, args);
        if (name === FlowCommand.RunGoalUpdate && !lost) {lost = true; throw new Error('Lost child pause reply');}
        return result;
    });
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-invocation="${id}"]`)!;
    const action = (id: string, key: Parameters<typeof t>[0]) => [...card(id).querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t(key))!;
    panel = new InvocationPanel({execute} as never, 's', document.body, vi.fn(), {operations: await ledger(), openChild});
    await vi.waitFor(async () => {await panel.refresh(); expect(card('child-first').querySelector('textarea')).not.toBeNull();});
    action('child-first', 'flow.invoke.openSession').click();
    await vi.waitFor(() => expect(openChild).toHaveBeenCalledWith(first.executionSessionId));
    expect(await commands.execute(FlowInvocationCommand.List, {sessionId: 's'})).toHaveLength(2);
    action('child-first', 'flow.invoke.pause').click();
    await vi.waitFor(async () => expect((await state.loadUIState('s'))?.operations?.[0]?.status).toBe('unknown'));
    const [record] = (await state.loadUIState('s'))!.operations as OperationRecord[];
    expect(record.input).toMatchObject({executionSessionId: first.executionSessionId});
    panel.destroy(); panel = new InvocationPanel({execute} as never, 's', document.body, vi.fn(), {operations: await ledger(), openChild});
    await vi.waitFor(async () => {await panel.refresh(); expect(card('child-first').querySelector('[data-control-reconcile]')).not.toBeNull();});
    card('child-first').querySelector<HTMLButtonElement>('[data-control-reconcile]')!.click();
    await vi.waitFor(async () => expect((await state.loadUIState('s'))?.operations?.[0]?.status).toBe('accepted'));
    expect(execute).toHaveBeenCalledWith(FlowCommand.RunControlReceipt,
        {sessionId: first.executionSessionId, taskId: first.rootTaskId, requestId: record.context.operationId});
    expect(execute.mock.calls.filter(([name]) => name === FlowCommand.RunGoalUpdate)).toHaveLength(1);
    card('child-first').querySelector<HTMLTextAreaElement>('textarea')!.value = 'Saved in child';
    card('child-first').querySelector<HTMLButtonElement>('[data-interaction-action="reply"]')!.click();
    await vi.waitFor(async () => {
        const snapshot = await commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: first.executionSessionId, taskId: first.rootTaskId});
        expect(snapshot.taskTree.some(task => task.interactions.same?.status === 'resolved')).toBe(true);
    });
    expect((await (await kernel.openTask(first.rootTaskId!)).stat()).stopped).toBe(true);
    action('child-first', 'flow.invoke.continue').click();
    await vi.waitFor(async () => {await panel.refresh(); expect(card('child-first').querySelector('[data-status]')?.textContent).toBe(t('flow.invoke.succeeded'));});
    action('child-first', 'flow.invoke.details').click();
    await vi.waitFor(() => expect(document.querySelector('dialog .dag-workbench')).not.toBeNull());
    document.querySelector<HTMLDialogElement>('dialog')!.close();
    action('child-second', 'flow.invoke.cancel').click();
    await vi.waitFor(async () => expect((await (await kernel.openTask(second.rootTaskId!)).status()).task.status).toBe('cancelled'));
    expect((await (await kernel.openTask(first.rootTaskId!)).status()).task.status).toBe('succeeded');
    expect(await kernel.listSessionTasks('s')).toEqual([]);
    expect(execute.mock.calls.filter(([name]) => name === FlowCommand.RunGet).every(([, args]) => args.sessionId !== 's')).toBe(true);
}, 15000);

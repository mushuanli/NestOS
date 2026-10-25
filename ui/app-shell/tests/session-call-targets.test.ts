// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {hasCommittedSubmission} from '@itookit/llm-session';
import {createOperationLedger} from '@itookit/llm-ui';
import {FlowCommand, type FlowDraft} from '@itookit/llm-flow/contracts';
import {createSessionChatBinding, createSessionChatView} from '../../llm-ui-adapter/src/independent/session';
import {LLMWorkspaceEditor} from '../../llm-ui-adapter/src/shell/LLMWorkspaceEditor';
import type {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {RpcPeer} from '@itookit/app-transport/application';
import type {ICommandBus} from '@itookit/llm-session/contracts';

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

it('selects an independent published Flow, submits through the real Session queue and settles the same operation ledger', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const flow: FlowDraft = {id: 'worker' as never, name: 'Worker', exposure: 'global', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'}, {name: 'count', type: 'number', default: 0}],
        nodes: [{id: 'return' as never, name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: {value: '${param.request}'}}], edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    await runtime.agentService.saveAgent({id: 'worker', name: 'Agent with the same id', type: 'agent', config: {systemPrompt: 'PRIVATE_POLICY'}});
    const sessionId = await runtime.sessionRepository.createSession('Target selector'); await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    const operations = createOperationLedger(), binding = createSessionChatBinding({session: runtime.sessionManager, commands: runtime.commandBus,
        operations, targetSelection: true, hasCommittedSubmission: submission => hasCommittedSubmission(runtime.sessionRepository, sessionId, submission)});
    cleanup.push(() => binding.dispose());
    const host = document.createElement('section'); document.body.append(host); const view = await createSessionChatView(host, binding);
    cleanup.push(() => view.destroy()); await binding.refreshTargets();
    const choices = binding.source.getSnapshot().callTargets!.entries;
    expect(choices.filter(choice => choice.target.id === 'worker').map(choice => choice.target.kind).sort()).toEqual(['agent', 'flow']);
    expect(JSON.stringify(choices)).not.toContain('PRIVATE_POLICY');
    const selected = choices.find(choice => choice.target.kind === 'flow' && choice.target.id === 'worker')!;
    const field = host.querySelector<HTMLSelectElement>('[data-call-target]')!; field.value = selected.id; field.dispatchEvent(new Event('change', {bubbles: true}));
    view.setText('Review the interface'); view.setArguments('{"count":0}'); await view.submit();
    await vi.waitFor(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
        expect(rounds).toHaveLength(1); expect(rounds[0].status).toBe('completed'); expect(rounds[0].target?.kind).toBe('flow');
        expect(rounds[0].flow?.parameters).toEqual({request: 'Review the interface', count: 0});
    }, {timeout: 10000});
    expect(operations.getSnapshot()).toHaveLength(1); expect(operations.getSnapshot()[0].status).toBe('accepted');
    expect(operations.getSnapshot()[0].input).toMatchObject({target: selected.target, input: {target: selected.target, values: {count: 0}}});
    expect(view.getDraft().text).toBe(''); expect(view.getDraft().target).toEqual(selected.target);
});

async function workspace(wait = false) {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    HTMLElement.prototype.scrollTo = vi.fn();
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const flow: FlowDraft = {id: 'worker' as never, name: 'Independent worker', exposure: 'global', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'}, {name: 'count', type: 'number', default: 0}],
        nodes: [{id: 'return' as never, name: 'Return', plugin: wait ? 'builtin.human' : 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: wait ? {requestId: 'approval', prompt: 'Wait'} : {value: '${param.request}'}}],
        edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    await runtime.agentService.saveAgent({id: 'worker', name: 'Same ID Agent', type: 'agent', config: {}});
    const sessionId = await runtime.sessionRepository.createSession('Workspace targets');
    const open = async (commands: ICommandBus = runtime.commandBus) => {
        const host = document.createElement('section'); document.body.append(host);
        const editor = new LLMWorkspaceEditor(host, {sessionId, sessionManager: runtime.sessionManager, commandBus: commands,
            sessionRepository: runtime.sessionRepository, agentService: runtime.agentService});
        let closed = false; const close = async () => {if (!closed) {closed = true; await editor.destroy(); host.remove();}};
        cleanup.push(close); await editor.init(host);
        const input = (editor as unknown as {chatInput: ChatInput}).chatInput; await input.refreshCallTargets();
        return {host, editor, input, close};
    };
    return {runtime, sessionId, open};
}

async function selectFlow(host: HTMLElement) {
    host.querySelector<HTMLButtonElement>('.llm-input__agent-trigger')!.click();
    await vi.waitFor(() => expect([...document.querySelectorAll('.llm-popup__item-label')].some(item => item.textContent === 'Independent worker')).toBe(true));
    const choice = [...document.querySelectorAll<HTMLElement>('.llm-popup__item')].find(item => item.querySelector('.llm-popup__item-label')?.textContent === 'Independent worker')!;
    choice.click();
}
async function submitForm(host: HTMLElement, text: string, edit?: (dialog: HTMLDialogElement) => void) {
    const area = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    area.value = text; area.dispatchEvent(new Event('input'));
    host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog [data-parameter]')).not.toBeNull());
    edit?.(document.querySelector<HTMLDialogElement>('dialog')!);
    document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(area.value).toBe(''));
}

it('uses the default workspace picker and queues a second Flow while the first send RPC is still suspended', async () => {
    const f = await workspace(), view = await f.open();
    await (await f.runtime.kernel.kernel.openSession(f.sessionId)).suspend();
    await selectFlow(view.host);
    expect(view.input.getConfig().target).toMatchObject({kind: 'flow', id: 'worker', version: '1'});
    expect(view.input.getConfig().agentId).toBe('');
    const original = f.runtime.commandBus.execute.bind(f.runtime.commandBus);
    let finish!: () => void; const blocked = new Promise<void>(resolve => {finish = resolve;});
    let calls = 0;
    const execute = vi.spyOn(f.runtime.commandBus, 'execute').mockImplementation(async (name, args) => {
        const value = await original(name, args);
        if (name === SessionCommand.Submit && ++calls === 1) await blocked;
        return value;
    });
    await submitForm(view.host, 'First request');
    await submitForm(view.host, 'Second request');
    expect(calls).toBe(2);
    const queue = await original<import('@itookit/llm-session/contracts').SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(queue.items.map(item => item.flowBinding?.inputResolution?.parameters)).toEqual([{request: 'First request', count: 0}, {request: 'Second request', count: 0}]);
    expect(execute.mock.calls.filter(([name]) => name === SessionCommand.Send)).toEqual([]);
    const saved = await f.runtime.sessionRepository.getUIState(f.sessionId);
    expect(saved?.operationRecords).toHaveLength(2); expect(saved?.operationRecords?.every(record => (record as {status: string}).status === 'accepted')).toBe(true);
    expect(saved?.branchDrafts?.main?.inputTarget).toMatchObject({kind: 'flow', id: 'worker'});
    finish(); await view.close();
    const reopened = await f.open();
    expect(reopened.input.getConfig().target).toEqual(view.input.getConfig().target);
    expect((await original<import('@itookit/llm-session/contracts').SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toHaveLength(2);
});

it('runs a first-class Flow from the default workspace and persists its display text separately from confirmed arguments', async () => {
    const f = await workspace(), view = await f.open(); await selectFlow(view.host);
    const resolve = vi.spyOn(f.runtime.agentService, 'getAgentConfig').mockRejectedValue(new Error('A Flow needs no Agent definition'));
    await submitForm(view.host, 'Original editor text', dialog => {dialog.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!.value = 'Confirmed arguments';});
    await vi.waitFor(async () => {
        const [round] = (await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds;
        expect(round?.status).toBe('completed'); expect(round.target).toMatchObject({kind: 'flow', id: 'worker'});
        expect(round.agentId).toBeUndefined(); expect(round.callInput?.source).toEqual({kind: 'arguments', value: {request: 'Confirmed arguments', count: 0}});
        expect(round.input[0].content).toBe('Original editor text');
    }, {timeout: 10000});
    expect(resolve).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(view.host.querySelector('[data-call-arguments]')?.textContent).toContain('Confirmed arguments'));
    const draft = await f.runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'worker'});
    await f.runtime.commandBus.execute(FlowCommand.DraftSave, {draft: {...draft, exposure: 'local', parameters: []}, expectedDraftVersion: draft.draftVersion});
    const [source] = (await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds;
    await expect(f.runtime.commandBus.execute(SessionCommand.CommitEdit, {messageId: `round-${source.id}-user`, newContent: 'Not executable arguments', autoRerun: true}))
        .rejects.toMatchObject({code: 'CALL_INPUT_EDITOR_REQUIRED'});
    view.host.querySelector<HTMLButtonElement>('[data-action="edit-arguments"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog [data-parameter="0"]')).not.toBeNull());
    expect(document.querySelector<HTMLTextAreaElement>('dialog [data-parameter="0"]')!.value).toBe('Confirmed arguments');
    document.querySelector<HTMLInputElement>('dialog [data-parameter="1"]')!.value = '7';
    document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(async () => {
        const [next] = (await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds;
        expect(next.id).not.toBe(source.id); expect(next.status).toBe('completed'); expect(next.target).toEqual(source.target);
        expect(next.flow?.parameters).toEqual({request: 'Confirmed arguments', count: 7});
        expect(next.executions[0].invocation?.retryOfInvocationId).toBe(source.executions[0].invocation?.invocationId);
    }, {timeout: 10000});
    expect((await f.runtime.commandBus.execute<{revision: number}>(FlowCommand.RevisionGet, {id: 'worker'})).revision).toBe(1);
});

it('reopens an unknown submission from the saved ledger and reconciles it without issuing a second call', async () => {
    const f = await workspace(), first = await f.open(); await selectFlow(first.host);
    const execute = f.runtime.commandBus.execute.bind(f.runtime.commandBus);
    const submit = vi.spyOn(f.runtime.commandBus, 'execute').mockImplementation(async (name, args) => {
        if (name === SessionCommand.Submit) throw new Error('Transport reply lost before any acceptance evidence');
        return execute(name, args);
    });
    const area = first.host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    area.value = 'Uncertain request'; area.dispatchEvent(new Event('input'));
    first.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog form')).not.toBeNull());
    document.querySelector<HTMLTextAreaElement>('dialog [data-parameter="0"]')!.value = 'Confirmed task';
    document.querySelector<HTMLInputElement>('dialog [data-parameter="1"]')!.value = '7';
    document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords?.[0]).toMatchObject({status: 'unknown'}));
    await first.close();
    const second = await f.open();
    expect(second.host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('Uncertain request');
    second.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog form')).not.toBeNull());
    expect(document.querySelector<HTMLTextAreaElement>('dialog [data-parameter="0"]')!.value).toBe('Confirmed task');
    expect(document.querySelector<HTMLInputElement>('dialog [data-parameter="1"]')!.value).toBe('7');
    document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(second.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
    expect(submit.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(1);
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords).toHaveLength(1);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toEqual([]);
    await second.close();
    const record = (await f.runtime.sessionRepository.getUIState(f.sessionId))!.operationRecords![0] as unknown as {input: {request: import('@itookit/llm-session/contracts').SubmissionRequest}};
    await execute(SessionCommand.Bind, {sessionId: f.sessionId});
    await (await f.runtime.kernel.kernel.openSession(f.sessionId)).suspend();
    await execute(SessionCommand.Submit, record.input.request);
    const queued = await execute<import('@itookit/llm-session/contracts').SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await execute(SessionCommand.EditInstructionQueue, {action: 'remove', id: record.input.request.submission!.id, expectedRevision: queued.revision});
    const removed = await execute(SessionCommand.GetInstructionQueue);
    const draft = await execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'worker'});
    const saved = await execute<{draft: FlowDraft}>(FlowCommand.DraftSave, {draft: {...draft, exposure: 'local'}, expectedDraftVersion: draft.draftVersion});
    await execute(FlowCommand.RevisionCreate, {draftId: 'worker', expectedDraftVersion: saved.draft.draftVersion});
    const third = await f.open();
    expect(third.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
    third.host.querySelector<HTMLButtonElement>('[data-call-reconcile]')!.click();
    await vi.waitFor(() => expect(third.host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe(''));
    expect(third.input.getConfig().input).toBeUndefined();
    expect((await f.runtime.sessionRepository.getUIState(f.sessionId))?.operationRecords?.[0]).toMatchObject({status: 'accepted'});
    expect(submit.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(1);
    expect(await execute(SessionCommand.GetInstructionQueue)).toEqual(removed);
    expect(await f.runtime.kernel.kernel.listSessionTasks(f.sessionId)).toEqual([]);
});

it('preserves the draft and never dispatches when saving the operation ledger fails', async () => {
    const f = await workspace(), view = await f.open(); await selectFlow(view.host);
    const update = f.runtime.sessionRepository.compareAndSetUIState!.bind(f.runtime.sessionRepository);
    vi.spyOn(f.runtime.sessionRepository, 'compareAndSetUIState').mockImplementation(async (sessionId, revision, state) => {
        if (state.operationRecords) throw Object.assign(new Error('Operation journal write failed'), {code: 'STORAGE_WRITE_FAILED'});
        return update(sessionId, revision, state);
    });
    const execute = vi.spyOn(f.runtime.commandBus, 'execute');
    const area = view.host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    area.value = 'Keep this input'; area.dispatchEvent(new Event('input'));
    view.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(document.querySelector('dialog form')).not.toBeNull());
    document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(view.host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false));
    expect(area.value).toBe('Keep this input'); expect(execute.mock.calls.some(([name]) => name === SessionCommand.Submit)).toBe(false);
    expect(await f.runtime.kernel.kernel.listSessionTasks(f.sessionId)).toEqual([]);
});

it('carries the default workspace target, confirmed arguments and committed history query through real RPC', async () => {
    const f = await workspace();
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    cleanup.push(async () => {await client.close(); await server.close();});
    const received: Array<{name: string; args?: unknown}> = [];
    const remote = client.decode(await server.expose({execute: (name: string, args?: unknown) => {
        received.push({name, args}); return f.runtime.commandBus.execute(name, args);
    }})) as Pick<ICommandBus, 'execute'>;
    const commands = {execute: remote.execute, register: f.runtime.commandBus.register.bind(f.runtime.commandBus), list: f.runtime.commandBus.list.bind(f.runtime.commandBus)};
    const view = await f.open(commands); await selectFlow(view.host); await submitForm(view.host, 'RPC request');
    const call = received.find(item => item.name === SessionCommand.Submit)!.args as import('@itookit/llm-session/contracts').SubmissionRequest;
    expect(call).toMatchObject({expectedSessionId: f.sessionId, expectedBranch: 'main', expectedTarget: {kind: 'flow', id: 'worker', version: '1'},
        source: {kind: 'arguments', value: {request: 'RPC request', count: 0}}, presentation: {text: 'RPC request'}});
    await vi.waitFor(async () => expect(await remote.execute(SessionCommand.HasCommittedSubmission, {sessionId: f.sessionId, submission: call.submission})).toBe(true));
    expect(await remote.execute(SessionCommand.GetSubmissionReceipt, call)).toMatchObject({operationId: call.submission!.id, status: 'accepted'});
    await expect(remote.execute(SessionCommand.GetSubmissionReceipt, {...call, source: {kind: 'arguments', value: {request: 'Changed', count: 0}}}))
        .rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    await expect(remote.execute(SessionCommand.GetSubmissionReceipt, {...call, expectedSessionId: 'stale-view'}))
        .rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    await expect(remote.execute(SessionCommand.Submit, {...call, expectedSessionId: 'stale-view'})).rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toHaveLength(1);
});

it.each(['local', 'rpc'])('submits an independent child from ChatView over %s and recovers a suspended admission reply', async transport => {
    const f = await workspace(); await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId: f.sessionId});
    const execute = async (name: string, args?: unknown) => {
        const result = await f.runtime.commandBus.execute(name, args);
        if (name === 'session.call.submit') return new Promise(() => {});
        return result;
    };
    let commands = {execute} as ICommandBus;
    if (transport === 'rpc') {
        let server!: RpcPeer;
        const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
        cleanup.push(async () => {await client.close(); await server.close();});
        commands = client.decode(await server.expose({execute})) as ICommandBus;
    }
    const openChild = vi.fn();
    const operations = createOperationLedger(), binding = createSessionChatBinding({session: f.runtime.sessionManager, commands,
        targetSelection: true, independentCalls: true, operations, openChild, branch: () => 'main',
        hasCommittedSubmission: submission => hasCommittedSubmission(f.runtime.sessionRepository, f.sessionId, submission)});
    cleanup.push(() => binding.dispose());
    const host = document.createElement('section'); document.body.append(host);
    const view = await createSessionChatView(host, binding); cleanup.push(() => view.destroy()); await binding.refreshTargets();
    const choice = binding.source.getSnapshot().callTargets!.entries.find(entry => entry.target.kind === 'flow')!;
    const target = host.querySelector<HTMLSelectElement>('[data-call-target]')!;
    target.value = choice.id; target.dispatchEvent(new Event('change', {bubbles: true}));
    const mode = host.querySelector<HTMLSelectElement>('[data-selector-id="callMode"]')!;
    mode.value = 'independent'; mode.dispatchEvent(new Event('change', {bubbles: true}));
    view.setText('Child request'); view.setArguments('{"count":0}');
    const sending = view.submit(); void sending.catch(() => {});
    await vi.waitFor(() => expect(operations.getSnapshot()[0]?.status).toBe('accepted'), {timeout: 10000});
    expect(view.getDraft().text).toBe('');
    expect(operations.getSnapshot()[0].input).toMatchObject({selection: {callMode: 'independent'}, independentTitle: 'worker'});
    const calls = await f.runtime.commandBus.execute<import('@itookit/llm-session/contracts').IndependentCallView[]>('session.calls.list', {sessionId: f.sessionId});
    expect(calls).toHaveLength(1); expect(calls[0].receipt.executionSessionId).not.toBe(f.sessionId);
    const card = host.querySelector<HTMLElement>('[data-independent-call]')!;
    expect(card).not.toBeNull(); expect(card.querySelector('[data-input]')!.textContent).toContain('Child request');
    card.querySelector<HTMLButtonElement>('[data-open-child]')!.click();
    expect(openChild).toHaveBeenCalledWith(calls[0].receipt.executionSessionId);
    await binding.refreshTargets(); expect(host.querySelector('[data-independent-call]')).toBe(card);
    expect(binding.source.getSnapshot().messages.find(message => message.id.startsWith('independent-call:'))?.submissionId).toBeUndefined();
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toEqual([]);
    expect(await f.runtime.commandBus.execute(SessionCommand.GetCurrentId)).toBe(f.sessionId);
    const currentMode = host.querySelector<HTMLSelectElement>('[data-selector-id="callMode"]')!;
    currentMode.value = 'current'; currentMode.dispatchEvent(new Event('change', {bubbles: true}));
    view.setText('Parent request'); view.setArguments('{"count":0}'); await view.submit();
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toHaveLength(1));
    const child = (await commands.execute<import('@itookit/llm-session/contracts').IndependentCallView[]>('session.calls.list', {sessionId: f.sessionId}))[0];
    const query = {sessionId: f.sessionId, branchId: 'main', callId: child.receipt.operationId,
        executionSessionId: child.receipt.executionSessionId!, taskId: child.receipt.execution!.taskId, requestId: `cancel-${transport}`};
    const cancelled = await commands.execute('session.call.cancel', {...query, expectedEpoch: child.executionState!.controlEpoch});
    expect(cancelled).toMatchObject({...query, receipt: {taskId: query.taskId, requestId: query.requestId}});
    expect(await commands.execute('session.call.cancellation.receipt', query)).toEqual(cancelled);
    expect(await f.runtime.commandBus.execute(SessionCommand.GetCurrentId)).toBe(f.sessionId);
});


it.each(['local', 'rpc'])('controls a real ChatView over %s with hanging replies and still accepts the next input', async transport => {
    const f = await workspace(true); await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId: f.sessionId});
    let cancels = 0; const actions: string[] = [];
    const execute = async (name: string, args?: unknown) => {
        const result = await f.runtime.commandBus.execute(name, args);
        if (name === 'session.call.cancel') {cancels++; return new Promise(() => {});}
        if (name === 'session.call.control') {actions.push((args as {action: string}).action); return new Promise(() => {});}
        return result;
    };
    let commands = {execute} as ICommandBus;
    if (transport === 'rpc') {
        let server!: RpcPeer;
        const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
        cleanup.push(async () => {await client.close(); await server.close();}); commands = client.decode(await server.expose({execute})) as ICommandBus;
    }
    const operations = createOperationLedger(), binding = createSessionChatBinding({session: f.runtime.sessionManager, commands, operations,
        targetSelection: true, independentCalls: true, branch: () => 'main',
        hasCommittedSubmission: submission => hasCommittedSubmission(f.runtime.sessionRepository, f.sessionId, submission)});
    cleanup.push(() => binding.dispose()); const host = document.createElement('section'); document.body.append(host);
    const view = await createSessionChatView(host, binding); cleanup.push(() => view.destroy()); await binding.refreshTargets();
    const choice = binding.source.getSnapshot().callTargets!.entries.find(entry => entry.target.kind === 'flow')!;
    const target = host.querySelector<HTMLSelectElement>('[data-call-target]')!; target.value = choice.id; target.dispatchEvent(new Event('change', {bubbles: true}));
    const mode = host.querySelector<HTMLSelectElement>('[data-selector-id="callMode"]')!; mode.value = 'independent'; mode.dispatchEvent(new Event('change', {bubbles: true}));
    view.setText('First task'); view.setArguments('{"count":0}'); await view.submit();
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[data-call-cancel]')?.hidden).toBe(false));
    await vi.waitFor(() => expect(host.querySelector('[data-call-interactions]')?.textContent).toContain('Wait'));
    view.setText('Next task');
    const state = () => host.querySelector<HTMLButtonElement>('[data-call-state-control]')!;
    await vi.waitFor(() => expect(state()?.hidden).toBe(false)); state().click();
    await vi.waitFor(() => expect(actions).toEqual(['pause']));
    await vi.waitFor(() => expect(operations.getSnapshot().find(record => (record.input as any)?.request?.action === 'pause')?.status).toBe('accepted'));
    await vi.waitFor(() => expect(state().disabled).toBe(false)); state().click();
    await vi.waitFor(() => expect(actions).toEqual(['pause', 'resume']));
    host.querySelector<HTMLButtonElement>('[data-call-cancel]')!.click();
    await vi.waitFor(() => expect(operations.getSnapshot().find(record => (record.input as any)?.protocol === 'independent-call-cancel-v1')?.status).toBe('accepted'));
    expect(view.getDraft().text).toBe('Next task'); expect(cancels).toBe(1);
    view.setArguments('{"count":0}'); await view.submit();
    await vi.waitFor(async () => expect(await f.runtime.commandBus.execute('session.calls.list', {sessionId: f.sessionId})).toHaveLength(2));
    expect(operations.getSnapshot().filter(record => record.kind === 'send')).toHaveLength(2);
    expect(await f.runtime.commandBus.execute(SessionCommand.GetCurrentId)).toBe(f.sessionId);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toEqual([]);
}, 15000);

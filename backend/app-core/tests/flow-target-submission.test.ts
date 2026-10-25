import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {SessionCommand, type SessionInstructionQueue} from '@itookit/llm-session/contracts';
import {FlowCommand, type FlowDraft} from '@itookit/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks();});
const definition = (exposure: FlowDraft['exposure'] = 'global'): FlowDraft => ({id: 'worker' as never, name: 'Independent worker',
    exposure, draftVersion: 1, updatedAt: 0, layout: {}, parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'},
        {name: 'count', type: 'number', default: 0}],
    nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
        config: {value: {request: '${param.request}', count: '${param.count}'}}}], edges: [],
    outputs: {result: {value: '${nodes.value.outputs.result}'}}});

async function setup(flow = definition()) {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    close.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const sessionId = await runtime.sessionRepository.createSession('Typed call');
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    return {runtime, sessionId};
}

function submit(runtime: Runtime, sessionId: string, id: string, values: Record<string, unknown> = {request: 'Typed arguments'}) {
    return runtime.commandBus.execute<string>(SessionCommand.Submit, {target: {kind: 'flow', id: 'worker', version: '1'},
        source: {kind: 'arguments', value: values}, submission: {id, source: {kind: 'conversation', ownerId: sessionId, id}}});
}

async function completed(runtime: Runtime, sessionId: string, count = 1) {
    await vi.waitFor(async () => {
        const history = await runtime.sessionRepository.readHistoryChain(sessionId);
        expect(history.rounds).toHaveLength(count); expect(history.rounds.every(round => round.status === 'completed')).toBe(true);
    }, {timeout: 10000});
    return (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
}

it('runs a published Flow through the normal queue without resolving any Agent definition', async () => {
    const {runtime, sessionId} = await setup();
    const resolve = vi.spyOn(runtime.agentService, 'getAgentConfig').mockRejectedValue(new Error('No Agents are available'));
    expect(await submit(runtime, sessionId, 'typed-root')).toBe('typed-root');
    const [round] = await completed(runtime, sessionId);
    expect(round.target).toMatchObject({kind: 'flow', id: 'worker', version: '1'}); expect(round.agentId).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect((await runtime.kernel.kernel.listSessionTasks(sessionId)).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
    expect(await submit(runtime, sessionId, 'typed-root')).toBe('typed-root');
    await expect(submit(runtime, sessionId, 'typed-root', {request: 'Different arguments'})).rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
});

it('binds composer text deterministically and accepts parameter/default-only input without a chat prompt', async () => {
    const {runtime, sessionId} = await setup();
    await runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'worker', version: '1'},
        source: {kind: 'composer', text: 'Use this request', attachments: [], values: {count: 0}}});
    await completed(runtime, sessionId);
    const root = (await runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.labels?.kind === 'flow-root')!;
    expect(root.output).toMatchObject({nodes: {__flow_return: {outputs: {result: {content: {request: 'Use this request', count: 0}}}}}});
});

it('rejects local or unavailable targets before admission and ignores injected plans and Agent identities', async () => {
    const {runtime, sessionId} = await setup(definition('local'));
    await expect(submit(runtime, sessionId, 'local-root')).rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    await expect(runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'missing'},
        source: {kind: 'arguments', value: {}}, agentId: 'default', instructionFlowBinding: {source: 'forged'}}))
        .rejects.toMatchObject({code: 'CALL_TARGET_UNAVAILABLE'});
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(queue.items).toEqual([]); expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('edits queued arguments from the frozen revision after publication changes and keeps failed edits out of storage', async () => {
    const {runtime, sessionId} = await setup();
    await (await runtime.kernel.kernel.openSession(sessionId)).suspend();
    await submit(runtime, sessionId, 'editable-call', {request: 'Original'});
    const queue = () => runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    let before = await queue(); expect(before.items[0].target).toEqual({kind: 'flow', id: 'worker', version: '1'});
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'worker'});
    const saved = await runtime.commandBus.execute<{draft: FlowDraft}>(FlowCommand.DraftSave, {draft: {...draft, exposure: 'local'}, expectedDraftVersion: draft.draftVersion});
    await runtime.commandBus.execute(FlowCommand.RevisionCreate, {draftId: 'worker', expectedDraftVersion: saved.draft.draftVersion});
    const execute = (source: unknown, revision: number) => runtime.commandBus.execute(SessionCommand.EditInstructionQueue,
        {action: 'update-input', id: 'editable-call', source, expectedRevision: revision});
    await expect(execute({kind: 'arguments', value: {request: 'Bad edit', count: 'wrong'}}, before.revision)).rejects.toThrow('must be number');
    expect((await queue()).revision).toBe(before.revision);
    await execute({kind: 'arguments', value: {request: 'Edited', count: 5}}, before.revision);
    before = await queue(); expect(before.items[0].flowBinding?.inputResolution?.parameters).toEqual({request: 'Edited', count: 5});
    await expect(execute({kind: 'arguments', value: {}}, before.revision - 1)).rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    await (await runtime.kernel.kernel.openSession(sessionId)).resume();
    const [round] = await completed(runtime, sessionId);
    expect(round.target).toMatchObject({kind: 'flow', version: '1'}); expect(round.flow?.parameters).toEqual({request: 'Edited', count: 5});
});

it('rebinds edited composer text rather than executing the pre-edit parameter snapshot', async () => {
    const {runtime, sessionId} = await setup(); await (await runtime.kernel.kernel.openSession(sessionId)).suspend();
    await runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'worker', version: '1'},
        source: {kind: 'composer', text: 'Original', attachments: [], values: {}},
        submission: {id: 'composer-call', source: {kind: 'conversation', ownerId: sessionId, id: 'composer-call'}}});
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'update', id: 'composer-call', text: 'Edited request', expectedRevision: queue.revision});
    await (await runtime.kernel.kernel.openSession(sessionId)).resume();
    const [round] = await completed(runtime, sessionId);
    expect(round.flow?.parameters?.request).toBe('Edited request');
});

it('lists independent published roots without reading prompt bodies and keeps draft scope separate from publication', async () => {
    const {runtime} = await setup();
    await runtime.agentService.saveAgent({id: 'worker', name: 'Same id Agent', type: 'agent', config: {systemPrompt: 'PRIVATE_PROMPT_BODY'}});
    await runtime.agentService.saveAgent({id: 'private', name: 'Private', exposure: 'local', type: 'agent', config: {}});
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'worker'});
    await runtime.commandBus.execute(FlowCommand.DraftSave, {draft: {...draft, exposure: 'local'}, expectedDraftVersion: draft.draftVersion});
    const prompt = vi.spyOn(runtime.agentService, 'getSystemPrompt').mockRejectedValue(new Error('Prompt bodies are not directory metadata'));
    const catalog = await runtime.commandBus.execute<import('@itookit/llm-session/contracts').RootTargetCatalog>(SessionCommand.ListTargets);
    expect(catalog.entries.filter(entry => entry.target.id === 'worker').map(entry => entry.target.kind).sort()).toEqual(['agent', 'flow']);
    expect(catalog.entries.some(entry => entry.target.id === 'private')).toBe(false); expect(prompt).not.toHaveBeenCalled();
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_PROMPT_BODY');
});

it('checks expected definition digests even if a mutable Agent source reuses its version string', async () => {
    const {runtime, sessionId} = await setup();
    const agent = {id: 'agent', name: 'Agent', type: 'agent' as const, version: 'v1', config: {systemPrompt: 'Original'}};
    await runtime.agentService.saveAgent(agent);
    const catalog = await runtime.commandBus.execute<import('@itookit/llm-session/contracts').RootTargetCatalog>(SessionCommand.ListTargets);
    const expected = catalog.entries.find(entry => entry.target.id === 'agent')!.target;
    await runtime.agentService.saveAgent({...agent, config: {systemPrompt: 'Changed without a version update'}});
    await expect(runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'agent', id: 'agent', version: 'v1'}, expectedTarget: expected,
        source: {kind: 'composer', text: 'Do not send', values: {}, attachments: []}})).rejects.toMatchObject({code: 'CALL_TARGET_CHANGED'});
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('regenerates a Flow as a new Flow invocation with preserved arguments and readable admission facts', async () => {
    const {runtime, sessionId} = await setup(); await submit(runtime, sessionId, 'original-flow', {request: 'Same task', count: 2});
    const [original] = await completed(runtime, sessionId), originalRoot = original.executions[0].taskId;
    const result = await runtime.commandBus.execute<import('@itookit/llm-session/contracts').RegenerateResult>(SessionCommand.Regenerate,
        {assistantId: `round-${original.id}-assistant`});
    expect(result.target).toEqual(original.target); expect(result.agentId).toBe('');
    const [next] = await completed(runtime, sessionId);
    expect(next.id).not.toBe(original.id); expect(next.target).toEqual(original.target); expect(next.agentId).toBeUndefined();
    expect(next.flow?.parameters).toEqual(original.flow?.parameters); expect(next.callInput?.admitted?.parameters).toEqual(original.flow?.parameters);
    expect(next.executions[0].invocation?.retryOfInvocationId).toBe(original.executions[0].invocation?.invocationId);
    expect((await (await runtime.kernel.kernel.openTask(originalRoot)).status()).task.status).toBe('succeeded');
    expect((await (await runtime.kernel.kernel.openTask(next.executions[0].taskId)).status()).task.labels).toMatchObject({targetKind: 'flow', targetId: 'worker', targetVersion: '1'});
});

it('rejects a stale Session binding before it can admit a call into another conversation', async () => {
    const {runtime, sessionId} = await setup(), other = await runtime.sessionRepository.createSession('Other conversation');
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: other});
    const request = {target: {kind: 'flow', id: 'worker', version: '1'}, source: {kind: 'arguments', value: {request: 'Old view input'}}};
    await expect(runtime.commandBus.execute(SessionCommand.Submit, {...request, expectedSessionId: sessionId}))
        .rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    await expect(runtime.commandBus.execute(SessionCommand.Submit, {...request,
        submission: {id: 'old-view', source: {kind: 'conversation', ownerId: sessionId, id: 'old-view'}}}))
        .rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    await expect(runtime.commandBus.execute(SessionCommand.HasCommittedSubmission, {sessionId, submission: {id: 'old-view', source: {kind: 'conversation', ownerId: sessionId, id: 'old-view'}}}))
        .rejects.toMatchObject({code: 'SUBMISSION_INVALID'});
    expect((await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toEqual([]);
    expect(await runtime.kernel.kernel.listSessionTasks(other)).toEqual([]);
});

it('rejects a new stale-branch call while reconciling the original accepted call after a branch switch', async () => {
    const {runtime, sessionId} = await setup();
    await (await runtime.kernel.kernel.openSession(sessionId)).suspend();
    await runtime.sessionRepository.updateManifest(sessionId, {branches: {main: null, review: null}});
    const request = {target: {kind: 'flow', id: 'worker', version: '1'}, expectedSessionId: sessionId, expectedBranch: 'main',
        source: {kind: 'arguments', value: {request: 'Original branch'}},
        submission: {id: 'branch-call', source: {kind: 'conversation', ownerId: sessionId, id: 'branch-call'}}};
    expect(await runtime.commandBus.execute(SessionCommand.Submit, request)).toBe('branch-call');
    await runtime.commandBus.execute('vcs.branch.switch', {branchName: 'review'});
    expect(await runtime.commandBus.execute(SessionCommand.Submit, request)).toBe('branch-call');
    const before = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await expect(runtime.commandBus.execute(SessionCommand.Submit, {...request,
        submission: {...request.submission, id: 'late-call'}})).rejects.toMatchObject({code: 'QUEUE_BRANCH_CHANGED'});
    await expect(runtime.commandBus.execute(SessionCommand.Submit, {...request, expectedBranch: 'review'})).rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    expect(await runtime.commandBus.execute(SessionCommand.GetInstructionQueue)).toEqual(before);
    expect(before.items).toHaveLength(1); expect(before.items[0]).toMatchObject({branch: 'main', expectedBranch: 'main'});
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('reconciles exact admission after a queued call is removed without requiring a history message or executing it', async () => {
    const {runtime, sessionId} = await setup(); await (await runtime.kernel.kernel.openSession(sessionId)).suspend();
    const request = {target: {kind: 'flow', id: 'worker', version: '1'}, expectedBranch: 'main',
        source: {kind: 'arguments', value: {request: 'Frozen request'}},
        submission: {id: 'receipt-call', source: {kind: 'conversation', ownerId: sessionId, id: 'receipt-call'}}};
    await runtime.commandBus.execute(SessionCommand.Submit, request);
    const before = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'remove', id: 'receipt-call', expectedRevision: before.revision});
    const removed = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    const receipt = await runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, request);
    expect(receipt).toEqual({operationId: 'receipt-call', status: 'accepted', evidence: 'queue'});
    await expect(runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, {...request, source: {kind: 'arguments', value: {request: 'Changed'}}}))
        .rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    expect(await runtime.commandBus.execute(SessionCommand.GetInstructionQueue)).toEqual(removed);
    expect((await runtime.sessionRepository.readHistoryChain(sessionId)).rounds).toEqual([]);
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('reconciles exact committed history after the bounded queue receipt window no longer contains the call', async () => {
    const {runtime, sessionId} = await setup(); await submit(runtime, sessionId, 'history-receipt', {request: 'History proof'}); await completed(runtime, sessionId);
    const session = await runtime.kernel.kernel.openSession(sessionId), stored = await session.getShared('conversation/instructions');
    await session.setShared('conversation/instructions', {...stored!.value as object, accepted: []}, {expectedVersion: stored!.version});
    const request = {target: {kind: 'flow', id: 'worker', version: '1'}, source: {kind: 'arguments', value: {request: 'History proof'}},
        submission: {id: 'history-receipt', source: {kind: 'conversation', ownerId: sessionId, id: 'history-receipt'}}};
    expect(await runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, request))
        .toEqual({operationId: 'history-receipt', status: 'accepted', evidence: 'history'});
    expect((await runtime.sessionRepository.readHistoryChain(sessionId)).rounds).toHaveLength(1);
});

it('logs distinct input, binding and lookup failures without recording frozen arguments', async () => {
    const {runtime, sessionId} = await setup(); await (await runtime.kernel.kernel.openSession(sessionId)).suspend();
    const warn = vi.spyOn(runtime.sessionManager.host.logger, 'warn');
    const request = {target: {kind: 'flow', id: 'worker', version: '1'}, expectedSessionId: sessionId,
        source: {kind: 'arguments', value: {request: 'PRIVATE_FROZEN_ARGUMENTS'}},
        submission: {id: 'receipt-diagnostics', source: {kind: 'conversation', ownerId: sessionId, id: 'receipt-diagnostics'}}};
    await runtime.commandBus.execute(SessionCommand.Submit, request);
    await expect(runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, {...request, source: {kind: 'arguments', value: {count: Infinity}}})).rejects.toThrow();
    await expect(runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, {...request, expectedSessionId: 'other'}))
        .rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    await expect(runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, {...request, source: {kind: 'arguments', value: {request: 'PRIVATE_CHANGED_ARGUMENTS'}}}))
        .rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    const failures = warn.mock.calls.filter(([, metadata]) => (metadata as {operation?: string})?.operation === 'call.receipt');
    expect(failures.map(([, metadata]) => (metadata as {stage: string}).stage)).toEqual(['input', 'binding', 'lookup']);
    for (const [, metadata] of failures) expect(metadata).toMatchObject({operationId: 'receipt-diagnostics', result: 'failure', code: expect.any(String), durationMs: expect.any(Number)});
    expect(JSON.stringify(failures)).not.toContain('PRIVATE_'); expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('inspects an accepted call without binding, opening a Kernel Session or changing another active view', async () => {
    const {runtime, sessionId} = await setup(); await (await runtime.kernel.kernel.openSession(sessionId)).suspend();
    const request = {target: {kind: 'flow', id: 'worker', version: '1'}, expectedSessionId: sessionId, expectedBranch: 'main',
        source: {kind: 'arguments', value: {request: 'Original request'}},
        submission: {id: 'unbound-receipt', source: {kind: 'conversation', ownerId: sessionId, id: 'unbound-receipt'}}};
    await runtime.commandBus.execute(SessionCommand.Submit, request);
    const other = await runtime.sessionRepository.createSession('Other active view');
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: other});
    const open = vi.spyOn(runtime.kernel.kernel, 'openSession'), bind = vi.spyOn(runtime.sessionManager, 'bindSession');
    const activatingRead = vi.spyOn(runtime.kernel.kernel, 'getShared');
    expect(await runtime.commandBus.execute(SessionCommand.InspectSubmissionReceipt, request))
        .toEqual({operationId: 'unbound-receipt', status: 'accepted', evidence: 'queue'});
    expect(runtime.sessionManager.getCurrentSessionId()).toBe(other); expect(open).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
    expect(activatingRead).not.toHaveBeenCalled();
    await expect(runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, request)).rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('reports unknown for an uninitialized Session without creating execution storage or reinterpreting its target', async () => {
    const {runtime} = await setup(), sessionId = await runtime.sessionRepository.createSession('Never activated');
    const open = vi.spyOn(runtime.kernel.kernel, 'openSession'), create = vi.spyOn(runtime.kernel.kernel, 'createSession');
    const activatingRead = vi.spyOn(runtime.kernel.kernel, 'getShared');
    const request = {target: {kind: 'flow', id: 'unavailable', version: '1'}, expectedSessionId: sessionId,
        source: {kind: 'arguments', value: {}}, submission: {id: 'never-sent', source: {kind: 'conversation', ownerId: sessionId, id: 'never-sent'}}};
    expect(await runtime.commandBus.execute(SessionCommand.InspectSubmissionReceipt, request)).toEqual({operationId: 'never-sent', status: 'unknown'});
    await expect(runtime.commandBus.execute(SessionCommand.InspectSubmissionReceipt, {...request, expectedSessionId: undefined})).rejects.toMatchObject({code: 'SUBMISSION_INVALID'});
    await expect(runtime.commandBus.execute(SessionCommand.InspectSubmissionReceipt, {...request, expectedSessionId: 'other'})).rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    expect(open).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(activatingRead).not.toHaveBeenCalled();
});

import {afterEach, expect, it, vi} from 'vitest';
import {randomUUID} from '@itookit/common';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanCommand, KanbanAutomationSettings} from '@itookit/kanban/contracts';
import type {IndependentCallInput, IndependentCallView, RootTargetCatalog} from '@itookit/llm-session/contracts';
import type {TaskRecord} from '@itookit/durable-kernel';
import {UserEventService} from '../src/events/service';
import {DiagnosticJournal} from '../src/diagnostics/journal';
import {createPersonalKanban} from '../src/kanban/personal';
import {parseAnalysis} from '../src/kanban/automation-analysis';
import type {PersonalKanbanAutomationOptions} from '../src/kanban/personal-automation';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of disposers.splice(0)) await close();});
async function fixture(autoAccept = false) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); disposers.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), events = await UserEventService.open(fs);
    const submitted = new Map<string, IndependentCallInput>(), completed = new Set<string>();
    const targets: RootTargetCatalog = {entries: ['planner', 'executor'].map(id => ({name: id,
        target: {kind: 'agent', id, version: '1', digest: id === 'planner' ? 'a'.repeat(64) : 'b'.repeat(64)}})), issues: []};
    let loseReply = false, hideAdmission = false, invalid = false;
    type Calls = PersonalKanbanAutomationOptions['calls'];
    const calls = {prepareTaskCall: vi.fn(async () => ({})),
        submitPreparedTaskCall: vi.fn(async (input: IndependentCallInput) => {
            submitted.set(input.request.submission!.id, input);
            if (loseReply) {loseReply = false; throw new Error('reply lost PRIVATE');}
            return {};
        }),
        inspectTaskCallSubmission: vi.fn(async (input: IndependentCallInput) => !hideAdmission && submitted.has(input.request.submission!.id)
            ? {executionSessionId: 'execution-' + input.request.submission!.id, submission: {task: {sessionId: input.request.expectedSessionId, taskId: input.request.submission!.id}}} : undefined),
        list: vi.fn(async (query: {sessionId: string}) => [...submitted.values()].filter(input => input.request.expectedSessionId === query.sessionId).map(input => ({input,
            callerState: {settled: input.request.expectedTarget!.id === 'planner' || completed.has(input.request.submission!.id)}, executionTree: {settled: true}} as IndependentCallView))),
    } as unknown as Calls;
    const kernel = {task: vi.fn(async (_session: string, id: string) => {
        const input = submitted.get(id)!, planner = input.request.expectedTarget!.id === 'planner';
        const item = planner ? JSON.parse(input.request.source.text).snapshot.item : undefined;
        const output = planner ? {message: {content: invalid ? 'INVALID PRIVATE' : JSON.stringify({ready: true, dependencies: item.id === 'second' ? ['first'] : [], reason: 'Uses the prerequisite result',
            estimate: {complexity: 1, workUnits: 1, durationMs: 60000, confidence: 'high'}})}} : {message: {content: 'Verified result'}};
        return {id, sessionId: _session, version: 1, effects: {}, exit: {status: 'succeeded', output: {exit: {status: 'succeeded', output}}}} as unknown as TaskRecord;
    })} as unknown as PersonalKanbanAutomationOptions['kernel'];
    const options: PersonalKanbanAutomationOptions = {calls, kernel, sessions: {ensureSession: vi.fn(async id => id), getManifest: vi.fn(async id => ({id, title: id})), listSummaries: async () => []} as unknown as PersonalKanbanAutomationOptions['sessions'],
        prepareSession: vi.fn(async () => true), catalog: vi.fn(async () => targets)};
    const diagnostics = new DiagnosticJournal();
    const open = () => createPersonalKanban(fs, events, diagnostics, options.sessions, kernel, options);
    const service = await open(); disposers.push(() => service.dispose());
    await service.create({id: 'board', title: 'Work', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'reviewer', 'coordinator']}], policy: {requireEstimate: true}});
    const command = async (value: KanbanCommand, api = service) => api.execute('board', {operationId: randomUUID(), expectedRevision: (await api.read('board')).revision, command: value});
    const catalog = await service.automationCatalog!();
    const settings: KanbanAutomationSettings = {enabled: true, autoAccept, planner: catalog.targets[0].reference, executor: catalog.targets[1].reference, coordinator: catalog.coordinator, worker: catalog.worker};
    await command({type: 'configure-automation', settings});
    const item = (id: string) => command({type: 'create-item', item: {id, title: id, responsibility: 'Deliver ' + id, acceptance: 'Evidence verified'}});
    return {service, command, item, calls, kernel, submitted, completed, settings, open, diagnostics,
        lose: () => {loseReply = true; hideAdmission = true;}, reveal: () => {hideAdmission = false;}, invalid: () => {invalid = true;},
        executions: () => [...submitted.entries()].filter(([, input]) => input.request.expectedTarget!.id === 'executor')};
}

it('analyzes newly added work, waits for independent acceptance and passes prerequisite evidence to the next execution', async () => {
    const f = await fixture(); await f.item('first'); await f.item('second');
    await f.service.scan(); expect(f.executions()).toHaveLength(1);
    const first = f.executions()[0][0]; f.completed.add(first);
    await f.service.scan();
    expect((await f.service.item('board', 'first')).item.status).toBe('review');
    expect((await f.service.item('board', 'second')).item.planning?.dependencies).toEqual(['first']);
    expect(f.executions()).toHaveLength(1);
    await f.command({type: 'accept-execution', dispatchId: first, accept: true});
    await f.service.scan(); expect(f.executions()).toHaveLength(2);
    const second = f.executions()[1], request = JSON.parse(second[1].request.source.text);
    expect(request.dependencies[0].outputs[0].value).toEqual({message: {content: 'Verified result'}});
    expect((await f.service.item('board', 'first')).item.id).toBe('first');
    f.completed.add(second[0]); await f.service.scan();
    expect((await f.service.item('board', 'second')).item.status).toBe('review');
});

it('persists an uncertain analysis and only inspects its original admission after reopening', async () => {
    const f = await fixture(); await f.item('first'); f.lose(); await f.service.scan();
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'unknown', code: 'AUTOMATION_ADMISSION_UNKNOWN'});
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    await f.service.dispose(); const reopened = await f.open(); disposers.push(() => reopened.dispose());
    await reopened.scan(); expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    f.reveal(); await reopened.scan(); expect(f.executions()).toHaveLength(1);
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(2);
});

it('pauses new dispatches while observing existing execution, and auto-accepts only when explicitly configured', async () => {
    const f = await fixture(true); await f.item('first'); await f.service.scan(); const id = f.executions()[0][0];
    await expect(f.command({type: 'configure-automation', settings: {...f.settings, autoAccept: false}})).rejects.toMatchObject({code: 'PLAN_EXECUTION_UNSETTLED'});
    await f.command({type: 'configure-automation', settings: {...f.settings, enabled: false}});
    await f.item('second'); f.completed.add(id); await f.service.scan();
    expect((await f.service.item('board', 'first')).item.status).toBe('completed'); expect(f.executions()).toHaveLength(1);
    await f.command({type: 'configure-automation', settings: f.settings}); await f.service.scan(); expect(f.executions()).toHaveLength(2);
});

it('records invalid planner output without dispatching work or leaking its text into diagnostics', async () => {
    const f = await fixture(); await f.item('first'); f.invalid(); await f.service.scan();
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'failed', code: 'AUTOMATION_ANALYSIS_INVALID'});
    expect(JSON.stringify(await f.diagnostics.query())).not.toContain('PRIVATE');
    expect(f.executions()).toHaveLength(0); await f.service.scan(); expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    expect(() => parseAnalysis({ready: true, dependencies: [12], reason: 'Invalid'})).toThrow('AUTOMATION_DEPENDENCIES_INVALID');
});

it('rejects a late analysis after the task is edited and analyzes the updated task with a new identity', async () => {
    const f = await fixture(); await f.item('first');
    const submit = vi.mocked(f.calls.submitPreparedTaskCall).getMockImplementation()!;
    vi.mocked(f.calls.submitPreparedTaskCall).mockImplementationOnce(async input => {
        const receipt = await submit(input);
        await f.command({type: 'edit-item', itemId: 'first', title: 'Updated', responsibility: 'Updated work', acceptance: 'New checks'});
        return receipt;
    });
    await f.service.scan();
    expect(f.executions()).toHaveLength(0);
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'failed', code: 'AUTOMATION_ANALYSIS_STALE'});
    await f.service.scan(); expect(f.executions()).toHaveLength(1);
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(3);
    expect((await f.service.item('board', 'first')).item.title).toBe('Updated');
});

it('admits one planning call when two observers reconcile the same durable item concurrently', async () => {
    const f = await fixture(); await f.item('first'); const second = await f.open(); disposers.push(() => second.dispose());
    await Promise.allSettled([f.service.scan(), second.scan()]);
    await f.service.scan();
    expect([...f.submitted.values()].filter(input => input.request.expectedTarget!.id === 'planner')).toHaveLength(1);
    expect(f.executions()).toHaveLength(1);
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'ready'});
});

it('runs the default runtime integration through real published Flows, Session leases and Kernel receipts', async () => {
    const {createApplicationRuntime} = await import('../src/runtime/create-application-runtime');
    const {FlowLibraryCommand} = await import('@itookit/app-contracts');
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), startupMode: 'interactive', digitalTwinAutoStart: false});
    disposers.push(() => runtime.dispose());
    const flow = (id: string, value: unknown): import('@itookit/llm-flow/contracts').FlowDraft => ({id: id as never, name: id,
        exposure: 'global', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'}],
        nodes: [{id: 'return' as never, name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value} as never}],
        edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}});
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow('planning', {ready: true, dependencies: [], reason: 'No prerequisites'}), flow('execution', 'Produced result')]});
    const service = runtime.kanban!, catalog = await service.automationCatalog!();
    const reference = (id: string) => catalog.targets.find(target => target.reference.id === id)!.reference;
    await service.create({id: 'automatic', title: 'Automatic', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator', 'reviewer']}], policy: {requireEstimate: false}});
    const execute = async (command: KanbanCommand) => service.execute('automatic', {operationId: randomUUID(), expectedRevision: (await service.read('automatic')).revision, command});
    await execute({type: 'configure-automation', settings: {enabled: true, autoAccept: true, planner: reference('planning'), executor: reference('execution'), coordinator: catalog.coordinator, worker: catalog.worker}});
    await execute({type: 'create-item', item: {id: 'work', title: 'Work', responsibility: 'Produce result', acceptance: 'Execution completes'}});
    await vi.waitFor(async () => {
        await service.scan(); const status = await service.analysisStatus!('automatic', 'work');
        if (status?.state === 'failed' || status?.state === 'unknown') throw new Error(JSON.stringify(status));
        expect((await service.item('automatic', 'work')).item.status).toBe('completed');
    }, {timeout: 10000, interval: 50});
    const workflow = await service.workflow('automatic');
    expect(Object.values(workflow.dispatches)).toHaveLength(1);
    expect(Object.values(workflow.dispatches)[0]).toMatchObject({outcome: 'accepted', outputs: [{name: 'result'}]});
    expect((await service.executionSession!('automatic', 'work')).current?.sessionId).toBeTruthy();
}, 15000);

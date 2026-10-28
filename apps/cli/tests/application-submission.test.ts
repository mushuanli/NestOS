import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindLocalApplicationServices, createApplicationClient} from '@itookit/app-core/host';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {SessionCommand, type SubmissionRequest} from '@itookit/llm-session/contracts';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {prepareSessionSubmission, readSubmissionFile, assertFrozenCallOptions} from '../src/application-submission';
import {FlowCommand, type FlowDraft, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import {RpcPeer} from '@itookit/app-transport/application';
import {executeApplicationCommand} from '../src/application-command';
import {installRuntimeDiagnostics} from '../src/diagnostics';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();});

async function setup(rpc = false) {
    const directory = await mkdtemp(path.join(tmpdir(), 'cli-call-')); cleanup.push(() => rm(directory, {recursive: true, force: true}));
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const definition: FlowDraft = {id: 'worker' as never, name: 'Worker', exposure: 'global', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'request', type: 'string', default: 'Default request', inputSource: 'composer.text'},
            {name: 'count', type: 'number', default: 4}, {name: 'enabled', type: 'boolean', default: true}],
        nodes: [{id: 'return' as never, name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: {value: {request: '${param.request}', count: '${param.count}', enabled: '${param.enabled}'}}}], edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [definition]});
    let services = bindLocalApplicationServices(runtime);
    const queries: Array<{command: string; query: boolean}> = [];
    if (rpc) {
        let server!: RpcPeer;
        const peer = new RpcPeer('client', call => {queries.push({command: String(call.args[0]), query: server.query(call)}); return server.handle(call);});
        server = new RpcPeer('server', call => peer.handle(call));
        services = {...services, commandBus: peer.decode(await server.expose(runtime.commandBus))};
        cleanup.push(async () => {await peer.close(); await server.close();});
    }
    const client = createApplicationClient(services); cleanup.push(() => client.close());
    const sessionId = await runtime.sessionRepository.createSession('CLI typed call');
    const call = (action: string, value?: string, options = {}) => executeApplicationCommand(client, 'session', [action, sessionId, ...(value !== undefined ? [value] : [])], options);
    return {runtime, client, sessionId, directory, call, queries};
}

it.each([false, true])('reads Session context bindings without activating a Session or starting queued work (RPC %s)', async rpc => {
    const f = await setup(rpc), open = vi.spyOn(f.client.backend, 'openSessionView'), nativeOpen = vi.spyOn(f.runtime.kernel.kernel, 'openSession');
    const activatingRead = vi.spyOn(f.runtime.kernel.kernel, 'getShared');
    const snapshot = await f.call('contexts');
    expect(snapshot).toEqual({revision: null, bindings: []});
    expect(open).not.toHaveBeenCalled(); expect(nativeOpen).not.toHaveBeenCalled(); expect(activatingRead).not.toHaveBeenCalled();
    if (rpc) expect(f.queries).toContainEqual({command: SessionCommand.ContextBindings, query: true});
    await expect(f.call('contexts', undefined, {branch: 'missing'})).rejects.toMatchObject({code: 'CONTEXT_QUERY_BRANCH_INVALID'});
    const count = f.queries.length;
    await expect(f.call('contexts', undefined, {cursor: 'PRIVATE_INVALID_CURSOR'})).rejects.toMatchObject({code: 'CONTEXT_CURSOR_INVALID', message: 'Invalid context pagination cursor JSON'});
    expect(f.queries).toHaveLength(count);
    expect(open).not.toHaveBeenCalled();
});

it('freezes explicit native context selection in the same submission file and never re-reads it during recovery', async () => {
    const f = await setup(), contextFile = path.join(f.directory, 'context.json'), submissionFile = path.join(f.directory, 'context-call.json');
    const selection = {mode: 'fork', sourceBindingId: 'binding', expectedBindingRevision: 4, expectedGeneration: 1, checkpointRef: 'head-1'};
    await writeFile(contextFile, JSON.stringify(selection));
    const execute = vi.fn(async (_name: string) => ({entries: [{name: 'Remote', target: {kind: 'agent', id: 'remote', version: 'v1', digest: 'digest'}}], issues: []}));
    const client = {services: {commandBus: {execute}}} as unknown as ApplicationClient;
    const request = await prepareSessionSubmission(client, f.sessionId, 'Increment only', 'main', {agent: 'remote', contextFile, submissionFile});
    expect(request.overrides?.harnessConversation).toEqual(selection);
    await writeFile(contextFile, JSON.stringify({mode: 'new'}));
    expect((await readSubmissionFile(submissionFile, f.sessionId)).overrides?.harnessConversation).toEqual(selection);
    expect(() => assertFrozenCallOptions({contextFile})).toThrow('A frozen submission cannot be overridden');
    await writeFile(contextFile, JSON.stringify({...selection, nativeSessionId: 'injected'}));
    await expect(prepareSessionSubmission(client, f.sessionId, 'Increment only', 'main', {agent: 'remote', contextFile}))
        .rejects.toMatchObject({code: 'CONTEXT_REQUEST_INVALID'});
    expect(execute.mock.calls.map(([name]) => name)).toEqual([SessionCommand.ListTargets, SessionCommand.ListTargets]);
});

it.each([false, true])('prepares, submits and inspects the same frozen Flow call without an Agent (RPC %s)', async rpc => {
    const f = await setup(rpc), submissionFile = path.join(f.directory, 'call.json'), paramsFile = path.join(f.directory, 'params.json');
    await writeFile(paramsFile, JSON.stringify({request: '', count: 0, enabled: false}));
    const open = vi.spyOn(f.client.backend, 'openSessionView');
    expect(await f.call('prepare', undefined, {flow: 'worker', paramsFile, submissionFile})).toMatchObject({prepared: true, target: {kind: 'flow', id: 'worker'}});
    expect(open).not.toHaveBeenCalled(); expect((await stat(submissionFile)).mode & 0o777).toBe(0o600);
    const request = JSON.parse(await readFile(submissionFile, 'utf8')) as SubmissionRequest;
    expect(request).toMatchObject({expectedSessionId: f.sessionId, expectedBranch: 'main', source: {kind: 'arguments', value: {request: '', count: 0, enabled: false}}});
    await writeFile(paramsFile, JSON.stringify({request: 'Changed after preparation', count: 99}));
    const resolve = vi.spyOn(f.runtime.agentService, 'getAgentConfig').mockRejectedValue(new Error('No Agent definition is available'));
    const submitted = await f.call('submit', submissionFile) as {accepted: string; execution: {status: string}};
    expect(submitted).toMatchObject({accepted: request.submission!.id, execution: {status: 'completed'}}); expect(resolve).not.toHaveBeenCalled();
    const [round] = (await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds;
    expect(round.flow?.parameters).toEqual({request: '', count: 0, enabled: false}); expect(round.target?.kind).toBe('flow'); expect(round.agentId).toBeUndefined();
    expect(await f.client.services.commandBus.execute(SessionCommand.GetSubmissionReceipt, request)).toMatchObject({status: 'accepted'});
    expect(await f.client.services.commandBus.execute(SessionCommand.HasCommittedSubmission, {sessionId: f.sessionId, submission: request.submission})).toBe(true);
    await f.runtime.commandBus.execute(SessionCommand.Unbind); open.mockClear();
    expect(await f.call('receipt', submissionFile)).toMatchObject({operationId: request.submission!.id, status: 'accepted'});
    expect(open).not.toHaveBeenCalled(); expect(f.runtime.sessionManager.getCurrentSessionId()).toBeNull();
    if (rpc) {
        const reads = new Set<string>([SessionCommand.ListTargets, SessionCommand.InspectSubmissionReceipt, SessionCommand.GetSubmissionReceipt, SessionCommand.HasCommittedSubmission]);
        expect(f.queries.filter(row => reads.has(row.command)).every(row => row.query)).toBe(true);
        expect(new Set(f.queries.filter(row => row.query && reads.has(row.command)).map(row => row.command))).toEqual(reads);
    }
});

it('persists a zero-text send before dispatch and refuses to overwrite its stable submission file', async () => {
    const f = await setup(), file = path.join(f.directory, 'call.json');
    const execute = vi.spyOn(f.runtime.commandBus, 'execute');
    expect(await f.call('send', undefined, {flow: 'worker', submissionFile: file})).toMatchObject({execution: {status: 'completed'}});
    const before = await readFile(file, 'utf8');
    await expect(f.call('send', undefined, {flow: 'worker', submissionFile: file})).rejects.toMatchObject({code: 'CLI_CALL_FILE_WRITE_FAILED'});
    expect(await readFile(file, 'utf8')).toBe(before); expect(execute.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(1);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toHaveLength(1);
});

it('reconciles a lost acknowledgement from the frozen file without replaying Submit or activating a Session', async () => {
    const f = await setup(), file = path.join(f.directory, 'call.json');
    await f.call('prepare', undefined, {flow: 'worker', submissionFile: file});
    const original = f.runtime.commandBus.execute.bind(f.runtime.commandBus);
    const execute = vi.spyOn(f.runtime.commandBus, 'execute').mockImplementation(async (name, args) => {
        const result = await original(name, args);
        if (name === SessionCommand.Submit) throw Object.assign(new Error('Submission reply lost'), {code: 'EIO'});
        return result;
    });
    await expect(f.call('submit', file, {connect: 'https://fixture'})).rejects.toMatchObject({code: 'EIO', requestId: expect.any(String)});
    await f.runtime.commandBus.execute(SessionCommand.Unbind);
    const open = vi.spyOn(f.client.backend, 'openSessionView');
    expect(await f.call('receipt', file)).toMatchObject({status: 'accepted'});
    expect(open).not.toHaveBeenCalled(); expect(execute.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(1);
});

it('leaves unknown input unexecuted and rejects malformed, conflicting or cross-Session files before opening a view', async () => {
    const f = await setup(), file = path.join(f.directory, 'call.json');
    await f.call('prepare', undefined, {flow: 'worker', submissionFile: file});
    const open = vi.spyOn(f.client.backend, 'openSessionView'), execute = vi.spyOn(f.runtime.commandBus, 'execute');
    expect(await f.call('receipt', file)).toMatchObject({status: 'unknown'});
    await expect(f.call('submit', file, {agent: 'default'})).rejects.toMatchObject({code: 'CLI_CALL_OPTIONS_CONFLICT'});
    const request = JSON.parse(await readFile(file, 'utf8')); await writeFile(file, JSON.stringify({...request, expectedSessionId: 'other'}));
    await expect(f.call('submit', file)).rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    await writeFile(file, '{"secret":"PRIVATE_CALL_BODY",');
    await expect(f.call('submit', file)).rejects.toMatchObject({code: 'CLI_CALL_JSON_INVALID'});
    expect(open).not.toHaveBeenCalled(); expect(execute.mock.calls.some(([name]) => name === SessionCommand.Submit)).toBe(false);
});

it('keeps malformed JSON and parameter values out of diagnostic logs', async () => {
    const f = await setup(), file = path.join(f.directory, 'bad.json');
    vi.stubEnv('NESTOS_DIAGNOSTICS_DIR', f.directory); const diagnostics = installRuntimeDiagnostics(); cleanup.push(() => diagnostics.dispose());
    await writeFile(file, '{"secret":"PRIVATE_CALL_BODY",');
    await expect(f.call('prepare', undefined, {flow: 'worker', paramsFile: file, submissionFile: path.join(f.directory, 'call.json')})).rejects.toMatchObject({code: 'CLI_CALL_JSON_INVALID'});
    const logs = await readFile(diagnostics.file, 'utf8');
    expect(logs).toContain('file-parse'); expect(logs).toContain('CLI_CALL_JSON_INVALID'); expect(logs).not.toContain('PRIVATE_CALL_BODY');
});

it('waits for interaction from its own real Flow child and preserves deferred admission', async () => {
    const f = await setup();
    const flow: FlowDraft = {id: 'interactive' as never, name: 'Interactive', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'answer', type: 'string', required: true, onMissing: 'interact'}],
        nodes: [{id: 'collect' as never, name: 'Collect', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: {fields: {answer: {type: 'string'}}}},
            {id: 'return' as never, name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: '${param.answer}'}}],
        edges: [{id: 'collected' as never, from: 'collect' as never, to: 'return' as never, output: 'result', input: 'input', kind: 'data'}],
        outputs: {result: {value: '${nodes.return.outputs.result}'}}};
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const sending = f.call('send', undefined, {flow: 'interactive'});
    await vi.waitFor(async () => expect((await f.runtime.kernel.kernel.listSessionPendingInteractionTasks(f.sessionId)).length).toBeGreaterThan(0));
    const result = await sending as {waitingForInput: boolean; execution: {rootTaskId: string}};
    expect(result.waitingForInput).toBe(true);
    const pending = await f.runtime.kernel.kernel.listSessionPendingInteractionTasks(f.sessionId);
    const snapshot = await f.runtime.commandBus.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: f.sessionId, taskId: result.execution.rootTaskId});
    expect(pending.some(task => snapshot.controlTaskIds?.includes(task.id))).toBe(true);
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toHaveLength(1);
});

it('binds JSON-looking text as text and validates the Flow Agent input signature saved during preparation', async () => {
    const f = await setup(), file = path.join(f.directory, 'agent-call.json');
    expect(await f.call('send', '{"count":99}', {flow: 'worker'})).toMatchObject({execution: {status: 'completed'}});
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds[0].flow?.parameters)
        .toEqual({request: '{"count":99}', count: 4, enabled: true});
    await f.runtime.agentService.saveAgent({id: 'flow-agent', name: 'Flow Agent', type: 'agent', config: {}, execution: {kind: 'flow', flowId: 'worker'}});
    await f.call('prepare', undefined, {agent: 'flow-agent', submissionFile: file});
    const request = JSON.parse(await readFile(file, 'utf8')) as SubmissionRequest;
    expect(request.overrides?.flowExpectedSignature).toMatchObject({id: 'worker', revision: 1});
    const draft = await f.runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'worker'});
    const saved = await f.runtime.commandBus.execute<{draft: FlowDraft}>(FlowCommand.DraftSave, {draft: {...draft, name: 'Changed input contract'}, expectedDraftVersion: draft.draftVersion});
    await f.runtime.commandBus.execute(FlowCommand.RevisionCreate, {draftId: 'worker', expectedDraftVersion: saved.draft.draftVersion});
    await expect(f.call('submit', file)).rejects.toMatchObject({code: 'FLOW_INPUT_SIGNATURE_CHANGED'});
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toHaveLength(1);
});

it('keeps the implicit host default Agent usable when it has no persisted directory definition', async () => {
    const f = await setup();
    await f.runtime.agentService.saveProvider({id: 'test', name: 'Test', implementation: 'openai-compatible', apiKey: 'test',
        baseURL: 'http://model.invalid', models: [{id: 'test-model', name: 'Test'}]});
    await f.runtime.agentService.saveConnection({id: 'test', name: 'Test', providerId: 'test', tiers: {standard: 'test-model'}});
    await f.runtime.agentService.setDefaultConnection('test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: ' + JSON.stringify({id: 'reply', model: 'test-model',
        choices: [{index: 0, delta: {role: 'assistant', content: 'Default Agent reply'}, finish_reason: 'stop'}]}) + '\n\ndata: [DONE]\n\n',
        {headers: {'content-type': 'text/event-stream'}})));
    expect(await f.call('send', 'Use the host default')).toMatchObject({target: {kind: 'agent', id: 'default'}, execution: {status: 'completed'}});
    const [round] = (await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds;
    expect(round.target).toMatchObject({kind: 'agent', id: 'default'}); expect(round.output[0].content).toBe('Default Agent reply');
});

it('rejects a Flow connection override for a plain Agent before creating a request file or execution view', async () => {
    const f = await setup(), bindings = path.join(f.directory, 'bindings.json'), submissionFile = path.join(f.directory, 'call.json');
    await f.runtime.agentService.saveAgent({id: 'plain', name: 'Plain Agent', type: 'agent', config: {systemPrompt: 'Policy'}});
    await writeFile(bindings, '{"slot":"connection"}');
    const open = vi.spyOn(f.client.backend, 'openSessionView');
    await expect(f.call('prepare', 'Task', {agent: 'plain', connectionBindingsFile: bindings, submissionFile})).rejects.toMatchObject({code: 'CLI_CALL_BINDINGS_INVALID'});
    expect(open).not.toHaveBeenCalled(); await expect(stat(submissionFile)).rejects.toMatchObject({code: 'ENOENT'});
});


it('diagnoses context validation and host failures without logging cursor contents or remote error text', async () => {
    const f = await setup(); vi.stubEnv('NESTOS_DIAGNOSTICS_DIR', f.directory);
    const diagnostics = installRuntimeDiagnostics(); cleanup.push(() => diagnostics.dispose());
    await f.call('contexts');
    await expect(f.call('contexts', undefined, {cursor: 'PRIVATE_CURSOR_TEXT'})).rejects.toMatchObject({code: 'CONTEXT_CURSOR_INVALID'});
    vi.spyOn(f.client.services.commandBus, 'execute').mockRejectedValueOnce(Object.assign(new Error('PRIVATE_REMOTE_TEXT'), {code: 'CONTEXT_CATALOG_CHANGED'}));
    await expect(f.call('contexts')).rejects.toMatchObject({code: 'CONTEXT_CATALOG_CHANGED'});
    const log = await readFile(diagnostics.file, 'utf8');
    expect(log).toContain('CONTEXT_CURSOR_INVALID'); expect(log).toContain('CONTEXT_CATALOG_CHANGED');
    expect(log).toContain('validate'); expect(log).toContain('query'); expect(log).toContain('observed'); expect(log).toContain('operationId');
    expect(log).not.toContain('PRIVATE_CURSOR_TEXT'); expect(log).not.toContain('PRIVATE_REMOTE_TEXT');
});


it('rejects native selection for a Flow before reading the selection file or writing a submission', async () => {
    const f = await setup(), submissionFile = path.join(f.directory, 'rejected-call.json');
    await expect(f.call('prepare', 'input', {flow: 'worker', contextFile: 'missing-private-file', submissionFile}))
        .rejects.toMatchObject({code: 'CONTEXT_TARGET_UNSUPPORTED'});
    await expect(stat(submissionFile)).rejects.toMatchObject({code: 'ENOENT'});
});

it('freezes scoped file references in CLI Flow arguments before saving the submission', async () => {
    const f = await setup(true), file = path.join(f.directory, 'references.json');
    const notes = await f.runtime.vfs.openFileSystem('/home/admin/notes');
    await notes.driver.createFile({parentPath: '/', name: 'input.md', content: '${literal.data}'});
    await f.call('prepare', undefined, {flow: 'worker', flowArgs: '@notes:/input.md 2 false', submissionFile: file});
    const saved = await readSubmissionFile(file, f.sessionId);
    expect(saved.source).toEqual({kind: 'arguments', value: {request: '${literal.data}', count: 2, enabled: false}});
    await notes.driver.writeContent('/input.md', 'changed');
    expect((await readSubmissionFile(file, f.sessionId)).source).toEqual(saved.source);
    expect(() => assertFrozenCallOptions({flowArgs: 'changed'})).toThrow('cannot be overridden');
});

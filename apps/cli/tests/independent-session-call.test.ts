import {installRuntimeDiagnostics} from '../src/diagnostics';
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {bindLocalApplicationServices, createApplicationClient} from '@itookit/app-core/host';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {IndependentCallCommand, type IndependentCallInput, type IndependentCallReceipt} from '@itookit/llm-session/contracts';
import {RpcPeer} from '@itookit/app-transport/application';
import {executeApplicationCommand} from '../src/application-command';
import {parseArgs} from '../src/cli';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs();});
async function setup(rpc = false, interact = false) {
    const directory = await mkdtemp(path.join(tmpdir(), 'cli-independent-')); cleanup.push(() => rm(directory, {recursive: true, force: true}));
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [{id: 'worker', name: 'Worker', exposure: 'global', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'count', type: 'number', ...(interact ? {required: true, onMissing: 'interact'} : {default: 2})}], nodes: [...(interact ? [{id: 'collect', name: 'Collect', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: {fields: {count: {type: 'number'}}}}] : []), {id: 'return', name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: '${param.count}'}}],
        edges: interact ? [{id: 'collected', from: 'collect', to: 'return', output: 'result', input: 'input', kind: 'data'}] : [], outputs: {result: {value: '${nodes.return.outputs.result}'}}}]});
    await runtime.agentService.saveAgent({id: 'worker-agent', name: 'Worker Agent', type: 'workflow', config: {}, execution: {kind: 'flow', flowId: 'worker'}});
    let services = bindLocalApplicationServices(runtime);
    const calls: Array<{name: string; query: boolean}> = [];
    if (rpc) {
        let server!: RpcPeer;
        const peer = new RpcPeer('client', call => {calls.push({name: String(call.args[0]), query: server.query(call)}); return server.handle(call);});
        server = new RpcPeer('server', call => peer.handle(call));
        services = {...services, commandBus: peer.decode(await server.expose(runtime.commandBus))};
        cleanup.push(async () => {await peer.close(); await server.close();});
    }
    const client = createApplicationClient(services); cleanup.push(() => client.close());
    const sessionId = await runtime.sessionRepository.createSession('Caller'), file = path.join(directory, 'call.json');
    const call = (action: string, value?: string, options = {}) => executeApplicationCommand(client, 'session', [action, sessionId, ...(value === undefined ? [] : [value])], options);
    return {runtime, client, sessionId, directory, file, call, calls};
}

it.each([false, true])('prepares, queries and submits an independent Flow through the CLI (RPC %s)', async rpc => {
    const f = await setup(rpc), open = vi.spyOn(f.client.backend, 'openSessionView');
    const prepared = await f.call('call-prepare', undefined, {flow: 'worker', callTitle: 'Separate task', submissionFile: f.file}) as {operationId: string};
    const frozen = JSON.parse(await readFile(f.file, 'utf8')) as IndependentCallInput;
    expect(frozen).toMatchObject({title: 'Separate task', request: {expectedSessionId: f.sessionId, expectedBranch: 'main', target: {kind: 'flow', id: 'worker'}}});
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(await f.call('call-receipt', f.file)).toMatchObject({operationId: prepared.operationId, status: 'unknown'});
    expect(open).not.toHaveBeenCalled();
    const result = await f.call('call-submit', f.file, rpc ? {connect: 'https://fixture.invalid'} : {}) as IndependentCallReceipt & {execution?: {status: string}};
    expect(result.status).toBe('accepted'); expect(result.executionSessionId).not.toBe(f.sessionId);
    if (!rpc) expect(result.execution?.status).toBe('completed'); else expect(open).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(result.executionSessionId!)).rounds[0]?.status).toBe('completed'));
    open.mockClear();
    expect(await f.call('call-receipt', f.file)).toMatchObject({status: 'accepted', executionSessionId: result.executionSessionId});
    expect(open).not.toHaveBeenCalled();
    expect((await f.runtime.sessionRepository.readHistoryChain(f.sessionId)).rounds).toEqual([]);
    if (rpc) expect(f.calls).toContainEqual({name: IndependentCallCommand.Inspect, query: true});
}, 15000);

it('freezes Agent input and explicit material references, and refuses overwriting the call file', async () => {
    const f = await setup(), paramsFile = path.join(f.directory, 'params.json'), transferFile = path.join(f.directory, 'transfer.json');
    await writeFile(paramsFile, JSON.stringify({count: 0}));
    await writeFile(transferFile, JSON.stringify({sessionId: f.sessionId, id: 'selected-material'}));
    await f.call('call-prepare', undefined, {agent: 'worker-agent', paramsFile, transferFile, callTitle: 'Agent task', submissionFile: f.file});
    const saved = await readFile(f.file, 'utf8');
    await writeFile(paramsFile, JSON.stringify({count: 99})); await writeFile(transferFile, '{}');
    expect(JSON.parse(saved)).toMatchObject({transfer: {id: 'selected-material'}, request: {source: {kind: 'arguments', value: {count: 0}}}});
    await expect(f.call('call-prepare', undefined, {flow: 'worker', callTitle: 'Another', submissionFile: f.file})).rejects.toMatchObject({code: 'CLI_CALL_FILE_WRITE_FAILED'});
    expect(await readFile(f.file, 'utf8')).toBe(saved);
    expect(await f.call('call-receipt', f.file)).toMatchObject({status: 'unknown'});
});

it('rejects frozen overrides and foreign caller identities before opening or submitting', async () => {
    const f = await setup();
    await f.call('call-prepare', undefined, {flow: 'worker', callTitle: 'Task', submissionFile: f.file});
    const execute = vi.spyOn(f.client.services.commandBus, 'execute'), open = vi.spyOn(f.client.backend, 'openSessionView');
    for (const options of [{callTitle: 'Changed'}, {transferFile: 'changed.json'}, {contextFile: 'changed.json'}, {branch: 'other'}])
        await expect(f.call('call-submit', f.file, options)).rejects.toMatchObject({code: 'CLI_CALL_OPTIONS_CONFLICT'});
    await expect(f.call('call-receipt', f.file, {follow: true})).rejects.toMatchObject({code: 'CLI_CALL_OPTIONS_CONFLICT'});
    const input = JSON.parse(await readFile(f.file, 'utf8')); input.request.expectedSessionId = 'another-caller'; await writeFile(f.file, JSON.stringify(input));
    await expect(f.call('call-submit', f.file)).rejects.toMatchObject({code: 'SUBMISSION_BINDING_CHANGED'});
    expect(execute).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

it('queries the original call after a lost submit reply without automatically resending', async () => {
    const f = await setup(); await f.call('call-prepare', undefined, {flow: 'worker', callTitle: 'Task', submissionFile: f.file});
    const execute = f.client.services.commandBus.execute.bind(f.client.services.commandBus); let submits = 0;
    vi.spyOn(f.client.services.commandBus, 'execute').mockImplementation(async (name, value) => {
        const result = await execute(name, value);
        if (name === IndependentCallCommand.Submit) {++submits; throw new Error('Lost reply');}
        return result;
    });
    await expect(f.call('call-submit', f.file, {connect: 'https://fixture.invalid'})).rejects.toThrow('Lost reply');
    expect(await f.call('call-receipt', f.file)).toMatchObject({status: 'accepted'}); expect(submits).toBe(1);
});

it('parses explicit independent title and content reference flags', () => {
    expect(parseArgs(['session', 'call-prepare', 'caller', '--call-title', 'Task', '--transfer', 'material.json']).options)
        .toMatchObject({callTitle: 'Task', transferFile: 'material.json'});
    expect(() => parseArgs(['session', 'call-prepare', 'caller', '--call-title'])).toThrow();
});


it('follows the selected child execution on a remote CLI connection', async () => {
    const f = await setup(true);
    await f.call('call-prepare', undefined, {agent: 'worker-agent', callTitle: 'Agent task', submissionFile: f.file});
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
        const result = await f.call('call-submit', f.file, {connect: 'https://fixture.invalid', follow: true});
        expect(result).toMatchObject({status: 'accepted', execution: {status: 'completed', waitingForInput: false}});
    } finally {output.mockRestore();}
}, 15000);

it('returns the child interaction state instead of waiting forever or inspecting the parent', async () => {
    const f = await setup(false, true);
    await f.call('call-prepare', undefined, {flow: 'worker', callTitle: 'Input task', submissionFile: f.file});
    expect(await f.call('call-submit', f.file)).toMatchObject({status: 'accepted', waitingForInput: true});
}, 15000);

it('logs observation failures without exposing the backend error body or resending the call', async () => {
    const f = await setup(); vi.stubEnv('NESTOS_DIAGNOSTICS_DIR', f.directory);
    const diagnostics = installRuntimeDiagnostics(); cleanup.push(() => diagnostics.dispose());
    await f.call('call-prepare', undefined, {flow: 'worker', callTitle: 'PRIVATE_TITLE', submissionFile: f.file});
    vi.spyOn(f.client.backend, 'openSessionView').mockRejectedValueOnce(new Error('PRIVATE_BACKEND_ERROR'));
    await expect(f.call('call-submit', f.file)).rejects.toThrow('PRIVATE_BACKEND_ERROR');
    expect(await f.call('call-receipt', f.file)).toMatchObject({status: 'accepted'});
    const log = await readFile(diagnostics.file, 'utf8');
    expect(log).toContain('CLI_CALL_OBSERVATION_FAILED'); expect(log).toContain('view-open'); expect(log).toContain('operationId');
    expect(log).not.toContain('PRIVATE_TITLE'); expect(log).not.toContain('PRIVATE_BACKEND_ERROR');
});


it('rejects independent-only inputs on ordinary submission commands rather than discarding them', async () => {
    const f = await setup(), execute = vi.spyOn(f.client.services.commandBus, 'execute');
    const open = vi.spyOn(f.client.backend, 'openSessionView');
    await expect(f.call('prepare', undefined, {flow: 'worker', callTitle: 'Independent', submissionFile: f.file}))
        .rejects.toMatchObject({code: 'CLI_CALL_OPTIONS_CONFLICT'});
    await expect(f.call('send', 'Input', {agent: 'worker-agent', transferFile: 'materials.json'}))
        .rejects.toMatchObject({code: 'CLI_CALL_OPTIONS_CONFLICT'});
    expect(execute).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    await expect(stat(f.file)).rejects.toMatchObject({code: 'ENOENT'});
});

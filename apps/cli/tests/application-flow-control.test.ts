import {executeApplicationCommand} from '../src/application-command';
import {afterEach, expect, it, vi} from 'vitest';
import {Kernel} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {DurableFlowExecutor, createBuiltinDagPluginRegistry, registerDurablePrograms} from '@itookit/llm-flow';
import {DagCommandService} from '../../../backend/llm-flow/src/flow/commands';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {flowControlCommand} from '../src/application-flow-control';
import type {ApplicationClient} from '@itookit/app-contracts/services';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks();});
function client(execute: (command: string, args?: unknown) => Promise<unknown>): ApplicationClient {
    return {services: {commandBus: {execute}}} as unknown as ApplicationClient;
}

it.each([
    ['pause', 's', 'root'], ['resume', 's', 'root', 'id', '-1'], ['pause', 's', 'root', 'id', '1.5'],
    ['withdraw-pause', 's', 'root', 'id', '9007199254740992'], ['cancel', 's', 'root', 'extra'], ['receipt', 's', 'root', ''],
])('rejects malformed controls before querying or mutating: %j', async (...args) => {
    const execute = vi.fn();
    await expect(flowControlCommand(client(execute), args)).rejects.toMatchObject({code: 'FLOW_CONTROL_REQUEST_INVALID'});
    expect(execute).not.toHaveBeenCalled();
});

it.each([
    ['pause', FlowCommand.RunGoalUpdate, {goal: {status: 'paused'}}],
    ['resume', FlowCommand.RunGoalUpdate, {goal: {status: 'active'}}],
    ['withdraw-pause', FlowCommand.RunPauseWithdraw, {}],
])('forwards %s with the exact supplied identity and epoch', async (action, command, extra) => {
    const execute = vi.fn(async () => ({root: {task: {}}}));
    await flowControlCommand(client(execute), [action as string, 's', 'root', 'request-one', '7']);
    expect(execute.mock.calls).toEqual([[FlowCommand.RunGet, {sessionId: 's', taskId: 'root'}],
        [command, {taskId: 'root', requestId: 'request-one', expectedEpoch: 7, ...extra}]]);
});

it('keeps scheduler reattachment separate and propagates uncertainty without retry', async () => {
    const execute = vi.fn(async (command: string) => {
        if (command === FlowCommand.RunGet) return {root: {task: {}}};
        throw Object.assign(new Error('Reply lost'), {code: 'ECONNECTION'});
    });
    await expect(flowControlCommand(client(execute), ['reattach', 's', 'root'])).rejects.toMatchObject({code: 'ECONNECTION'});
    expect(execute.mock.calls.map(([command]) => command)).toEqual([FlowCommand.RunGet, FlowCommand.RunResume]);
});

it('only reports an observed receipt when the persisted current identity matches', async () => {
    const execute = vi.fn(async () => ({root: {task: {control: {requestId: 'newer', mode: 'pause', epoch: 8, acknowledged: false}}},
        controlStats: {root: {stopped: false}}}));
    expect(await flowControlCommand(client(execute), ['receipt', 's', 'root', 'older'])).toMatchObject({outcome: 'unknown'});
    expect(await flowControlCommand(client(execute), ['receipt', 's', 'root', 'newer'])).toMatchObject({outcome: 'observed', control: {acknowledged: false}, stat: {stopped: false}});
    expect(execute.mock.calls).toHaveLength(2);
});

it('controls a real Flow, preserves its receipt across callers, and rejects a stale new request', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const kernel = new Kernel({catalog: {fs}, pollMs: 5}), plugins = createBuiltinDagPluginRegistry();
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/session'})});
    registerDurablePrograms(kernel); await kernel.initialize(); await kernel.createSession({id: 's', storage: {kind: 'test', locator: null}});
    const executor = new DurableFlowExecutor({kernel, plugins});
    close.push(async () => {kernel.dispose(); await executor.waitIdle(); await kernel.waitIdle(); await manager.dispose();});
    const handlers = new Map<string, (args: any) => any>();
    new DagCommandService({kernel, plugins, flowStore: {} as never}).register({register: (name, handler) => handlers.set(name, handler)});
    const port = () => client(async (command, args) => handlers.get(command)!(args));
    const run = await executor.submit('s', {nodes: [{id: 'wait', name: 'Wait', plugin: 'builtin.human', pluginVersion: '1.0.0',
        config: {requestId: 'answer', prompt: 'Fixture'}, inputs: {}}], edges: []});
    await vi.waitFor(() => expect(run.nodes.has('wait')).toBe(true));
    await executeApplicationCommand(port(), 'flow-run', ['pause', 's', run.root.id, 'pause-one', '0'], {});
    expect(await flowControlCommand(port(), ['receipt', 's', run.root.id, 'pause-one'])).toMatchObject({outcome: 'observed', control: {mode: 'pause'}});
    await flowControlCommand(port(), ['pause', 's', run.root.id, 'pause-one', '0']);
    await expect(flowControlCommand(port(), ['resume', 's', run.root.id, 'stale-resume', '0'])).rejects.toMatchObject({code: 'CONFLICT'});
    await flowControlCommand(port(), ['cancel', 's', run.root.id]);
    expect((await run.root.wait({timeoutMs: 2000})).status).toBe('cancelled');
});


it('does not issue a mutation after target lookup or authorization fails', async () => {
    const execute = vi.fn(async () => {throw Object.assign(new Error('Access denied'), {code: 'FORBIDDEN'});});
    await expect(flowControlCommand(client(execute), ['cancel', 's', 'root'])).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(execute).toHaveBeenCalledOnce();
});

import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {CommandBus} from '@itookit/llm-session';
import {InputSourceCommand, type InputSourceExecution} from '@itookit/app-contracts';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {registerInputSourceExecution} from '../src/host/input-source-execution';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
it('persists source identity, preserves approval and reconciles a lost response without executing again', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const commands = new CommandBus(), fs = await manager.openFileSystem('/');
    const runs: any[] = [];
    const start = vi.fn(async (spec: any) => {runs.push({taskId: 'task-source', invocation: spec.invocation}); throw new Error('response lost');});
    commands.register(FlowCommand.RunStart, start);
    commands.register(FlowCommand.RunList, async () => runs);
    const writable = vi.fn(async () => true), ensureSession = vi.fn(async () => {});
    registerInputSourceExecution({commands, fs, kernel: {openSession: async () => ({})} as any,
        repository: {ensureSession} as any, writable, tools: async () => [{id: 'fixture.echo', version: '1', name: 'Echo'}]});
    const input: InputSourceExecution = {requestId: 'source-request', scope: {navigation: 'notes'}, source: {kind: 'tool', toolId: 'fixture.echo', toolVersion: '1', args: {text: 'private'}}};
    await expect(commands.execute(InputSourceCommand.Execute, input)).rejects.toThrow('response lost');
    const receipt = await commands.execute<any>(InputSourceCommand.Inspect, {requestId: input.requestId});
    expect(receipt).toMatchObject({sessionId: expect.stringMatching(/^node-/), taskId: 'task-source'});
    expect(start.mock.calls[0][0].flow.nodes[0]).toMatchObject({capabilities: ['fixture.echo'], config: {approval: 'all', args: {text: 'private'}}});
    expect(await commands.execute(InputSourceCommand.Execute, input)).toEqual(receipt);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(commands.execute(InputSourceCommand.Execute, {...input, source: {...input.source, args: {text: 'changed'}}})).rejects.toThrow('INPUT_SOURCE_REQUEST_CONFLICT');
    writable.mockResolvedValue(false);
    await expect(commands.execute(InputSourceCommand.Execute, {...input, requestId: 'denied-request'})).rejects.toThrow('SESSION_READ_ONLY');
    expect(start).toHaveBeenCalledTimes(1);
});

it('executes a published source Flow through the application runtime', async () => {
    const {createApplicationRuntime} = await import('../src/runtime/create-application-runtime');
    const {externalFlow} = await import('./fixtures/flow-library');
    const {FlowLibraryCommand} = await import('@itookit/app-contracts');
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), digitalTwinAutoStart: false});
    closes.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [externalFlow('source-fixture')]});
    const flow = await runtime.commandBus.execute<any>(FlowCommand.RevisionGet, {id: 'source-fixture'});
    const input: InputSourceExecution = {requestId: 'actual-source', scope: {navigation: 'notes'},
        source: {kind: 'flow', flowId: flow.id, revision: flow.revision, digest: flow.digest, parameters: {}}};
    const receipt = await runtime.commandBus.execute<any>(InputSourceCommand.Execute, input);
    let snapshot: any;
    await vi.waitFor(async () => {
        snapshot = await runtime.commandBus.execute(FlowCommand.RunGet, receipt);
        expect(snapshot.root.task.status).toBe('succeeded');
    }, {timeout: 10000});
    expect(JSON.stringify(snapshot.root.task.output)).toContain('fixture');
    expect(await runtime.commandBus.execute(InputSourceCommand.Inspect, {requestId: input.requestId})).toEqual(receipt);
    const tools = await runtime.commandBus.execute<any[]>(InputSourceCommand.Catalog);
    const tool = tools.find(tool => tool.id === 'Read'); expect(tool).toBeDefined();
    const toolReceipt = await runtime.commandBus.execute<any>(InputSourceCommand.Execute, {requestId: 'actual-tool', scope: {navigation: 'notes'},
        source: {kind: 'tool', toolId: tool.id, toolVersion: tool.version, args: {file_path: '/missing.txt'}}});
    let pending: any;
    await vi.waitFor(async () => {
        const tasks = await runtime.kernel.kernel.listSessionTasks(toolReceipt.sessionId);
        pending = tasks.flatMap(task => Object.values(task.interactions ?? {}).map(interaction => ({task, interaction})))
            .find(({interaction}: any) => interaction.status === 'pending');
        expect(pending).toBeDefined();
    }, {timeout: 10000});
    await runtime.commandBus.execute(FlowCommand.RunRespond, {taskId: toolReceipt.taskId, targetTaskId: pending.task.id,
        requestId: pending.interaction.id, responseRequestId: 'deny-source', value: {approved: false}});
    await vi.waitFor(async () => {
        const denied = await runtime.commandBus.execute<any>(FlowCommand.RunGet, toolReceipt);
        expect(denied.root.task.status).toBe('failed');
    }, {timeout: 10000});
});

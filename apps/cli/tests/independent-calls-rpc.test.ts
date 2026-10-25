import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {RpcPeer} from '@itookit/app-transport/application';
import {IndependentCallCommand, SessionCommand, type IndependentCallReceipt, type ICommandBus, type RootTargetCatalog} from '@itookit/llm-session/contracts';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [{id: 'rpc-call', name: 'RPC call', exposure: 'global', draftVersion: 1,
        updatedAt: 0, layout: {}, parameters: [], nodes: [{id: 'return', name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'done'}}],
        edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}}]});
    const parent = await runtime.sessionRepository.createSession('Caller');
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: parent});
    const catalog = await runtime.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const target = catalog.entries.find(entry => entry.target.id === 'rpc-call')!.target;
    const input = (id: string) => ({title: 'Independent', request: {expectedSessionId: parent, expectedBranch: 'main',
        target: {kind: target.kind, id: target.id, version: target.version}, expectedTarget: target,
        source: {kind: 'arguments' as const, value: {}}, submission: {id, source: {kind: 'conversation', ownerId: parent, id}}}});
    return {runtime, input};
}

it('queries durable child acceptance over RPC while the original submit response is suspended', async () => {
    const f = await fixture(), input = f.input('rpc-suspended');
    let release!: () => void, accepted = false, server!: RpcPeer;
    const suspended = new Promise<void>(done => {release = done;}), observed: Array<{name: string; query: boolean}> = [];
    const client = new RpcPeer('client', call => {observed.push({name: String(call.args[0]), query: server.query(call)}); return server.handle(call);});
    server = new RpcPeer('server', call => client.handle(call));
    const exposed = {list: () => f.runtime.commandBus.list(), execute: async (name: string, value: unknown) => {
        const result = await f.runtime.commandBus.execute(name, value);
        if (name === IndependentCallCommand.Submit) {accepted = true; await suspended;}
        return result;
    }};
    const bus = client.decode(await server.expose(exposed)) as ICommandBus;
    const pending = bus.execute<IndependentCallReceipt>(IndependentCallCommand.Submit, input);
    try {
        await vi.waitFor(() => expect(accepted).toBe(true));
        const receipt = await bus.execute<IndependentCallReceipt>(IndependentCallCommand.Inspect, input);
        expect(receipt.status).toBe('accepted'); expect(receipt.executionSessionId).toBeTruthy();
        expect(observed).toContainEqual({name: IndependentCallCommand.Inspect, query: true});
        let execution = receipt.execution;
        await vi.waitFor(async () => {execution = (await bus.execute<IndependentCallReceipt>(IndependentCallCommand.Inspect, input)).execution; expect(execution).toBeTruthy();});
        const page = await bus.execute<{asOfSequence: number}>(IndependentCallCommand.Descendants, {sessionId: receipt.callerSessionId,
            branchId: 'main', callId: receipt.operationId, executionSessionId: receipt.executionSessionId, taskId: execution!.taskId});
        expect(page.asOfSequence).toBeGreaterThan(0); expect(observed).toContainEqual({name: IndependentCallCommand.Descendants, query: true});

        release(); expect((await pending).executionSessionId).toBe(receipt.executionSessionId);
    } finally {release(); await pending; await client.close(); await server.close();}
}, 15000);

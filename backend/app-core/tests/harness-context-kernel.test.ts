import {expect, it, vi} from 'vitest';
import {Kernel, bindCapabilities} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {HarnessProgram, HarnessExecutionEffect} from '@itookit/kernel-adapters';
import {sha256HexSync} from '@itookit/common';
import {createHarnessExecutionProvider} from '../src/projects/harness-execution';
import {createHarnessCleanupState} from '../src/projects/harness-cleanup-state';
import {createHarnessContextCleanup} from '../src/projects/harness-context-cleanup';
import {CONTEXT_BINDINGS_KEY} from '../src/projects/harness-context-bindings';
import {context} from './harness-context-fixture';
import {fixture, complete, request} from './harness-execution-fixture';

it.each(['complete', 'cancel'] as const)('settles context ownership through real Kernel execution and host cleanup: %s', async mode => {
    const f = fixture(), {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/'), kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/session'})});
    const gate = vi.fn(async (_sessionId: string) => {});
    const provider = createHarnessExecutionProvider(f.connections, {pollMs: 5, cancelTimeoutMs: 1000,
        stateForCleanup: createHarnessCleanupState(() => kernel, gate), settleContextForCleanup: createHarnessContextCleanup(() => kernel, gate)});
    kernel.registerProgram(new HarnessProgram()); kernel.registerEffect(new HarnessExecutionEffect(provider));
    try {
        await kernel.initialize(); const session = await kernel.createSession({id: 'real-session', storage: {kind: 'test', locator: null}});
        const messages = [{role: 'user', content: 'Scoped material'}], digest = sha256HexSync(JSON.stringify(messages));
        const task = await session.spawn({program: {kind: 'kernel-adapters.harness', version: '1'}, deferStart: true,
            input: {connection: request.connection, messages, contextSnapshot: {id: 'snapshot', digest},
                context: {...context, input: {mode: 'host-assembled', snapshotRef: 'snapshot', digest}}}});
        await bindCapabilities(task, [{kind: 'harness', uri: 'harness://test', rights: ['execute'], signalKey: 'harnessHandleId'}]);
        if (mode === 'complete') complete(f);
        else vi.mocked(f.client.interrupt).mockImplementation(async (_profile, _session, _turn, options) => {
            f.data.history.turns = [{id: 'native-turn', status: 'cancelled', items: []}];
            f.push('turn/completed', {threadId: 'native-session', turn: {id: 'native-turn', status: 'cancelled'}});
            f.committed(options, {});
        });
        await task.start();
        await vi.waitFor(() => expect(f.client.turn).toHaveBeenCalledTimes(1));
        if (mode === 'cancel') {await task.cancel('test cancellation'); await task.waitStopped({timeoutMs: 5000});}
        else await task.wait({timeoutMs: 5000});
        const collection = (await session.getShared(CONTEXT_BINDINGS_KEY))!.value as any;
        const bindings = Object.values(collection.bindings) as any[];
        expect(bindings).toHaveLength(1); expect(bindings[0]).toMatchObject({knownHeadRef: 'native-turn', lastOperation: {invocationId: context.invocationId}});
        expect(bindings[0].activeOperation).toBeUndefined(); expect(bindings[0].settlement).toBeUndefined();
        expect(bindings[0].checkpoints).toHaveLength(1);
        expect((await task.status()).task.status).toBe(mode === 'complete' ? 'succeeded' : 'cancelled');
        if (mode === 'cancel') expect(gate).toHaveBeenCalledWith('real-session');
    } finally {kernel.dispose(); await kernel.waitIdle(); await manager.dispose();}
}, 15000);

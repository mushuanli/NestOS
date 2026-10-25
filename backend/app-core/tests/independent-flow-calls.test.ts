import {expect, it} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {FlowCommand, type FlowDraft, type FlowRevision} from '@itookit/llm-flow/contracts';
import {FlowInvocationCommand, SessionCommand, type FlowInvocationRecord} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

it('prepares child storage and host ownership before admitting one independent execution per request', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    try {
        const definition = {id: 'independent', name: 'Independent', draftVersion: 1, updatedAt: 0, parameters: [],
            nodes: [{id: 'value', name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'done'}}],
            edges: []} as unknown as FlowDraft;
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [definition]});
        const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: definition.id});
        const {revision} = await runtime.commandBus.execute<{revision: FlowRevision}>(FlowCommand.RevisionCreate,
            {draftId: draft.id, expectedDraftVersion: draft.draftVersion});
        const parent = await runtime.sessionRepository.createSession('Caller');
        await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: parent});
        const request = {sessionId: parent, requestId: 'independent-call', execution: 'child', flowId: revision.id,
            revision: revision.revision, parameters: {}};
        const first = await runtime.commandBus.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, request);
        const again = await runtime.commandBus.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, request);
        const second = await runtime.commandBus.execute<FlowInvocationRecord>(FlowInvocationCommand.Invoke, {...request, requestId: 'second-call'});
        expect(again).toEqual(first); expect(first.executionSessionId).not.toBe(parent);
        expect(second.executionSessionId).not.toBe(first.executionSessionId);
        expect((await runtime.sessionRepository.getManifest(first.executionSessionId!)).parentSessionId).toBe(parent);
        expect((await (await runtime.kernel.kernel.openTask(first.rootTaskId!)).wait({timeoutMs: 5000})).status).toBe('succeeded');
        expect(await runtime.kernel.kernel.listSessionTasks(parent)).toEqual([]);
        expect((await runtime.sessionRepository.readHistoryChain(parent)).rounds).toEqual([]);
        expect((await runtime.kernel.kernel.listSessionTasks(first.executionSessionId!)).filter(task => task.labels?.kind === 'flow-root')).toHaveLength(1);
        const calls = await runtime.commandBus.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, {sessionId: parent});
        expect(calls.map(call => call.invocationId)).toEqual([first.invocationId, second.invocationId]);
    } finally {await runtime.dispose();}
}, 15000);

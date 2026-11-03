import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import type {FlowDraft} from '@itookit/llm-flow/contracts';
import type {RootTargetCatalog, IndependentCallInput} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {createSessionExecutionPreparer} from '../src/session/prepare-session-execution';
import {publishedOperation} from '../src/run/published-operation';
it('executes a real published Flow through durable Task-call and reads its Return result', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    try {
        const result = {schema: 'nestos.kanban.operation-result/1', operationId: 'operation', sourceVersion: 'source', targetVersion: 'target', version: 'candidate'};
        const flow: FlowDraft = {id: 'operation-fixture' as never, name: 'Operation fixture', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'context', type: 'string', required: true, role: 'input'}],
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: result}}], edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
        const catalog = await runtime.commandBus.execute<RootTargetCatalog>('session.targets.list'), target = catalog.entries.find(row => row.target.id === flow.id)!.target;
        const port = publishedOperation({calls: runtime.independentCalls!, kernel: runtime.kernel.kernel, ensureSession: (id, title) => runtime.sessionRepository.ensureSession(id, title), prepareSession: async id => {await createSessionExecutionPreparer(runtime.kernel.kernel)(id); return runtime.prepareSession(id);}});
        const input: IndependentCallInput = {title: 'Fixture', request: {expectedSessionId: 'operation', expectedBranch: 'main', expectedTarget: target, target: {kind: 'flow', id: target.id, version: target.version}, source: {kind: 'composer', text: '', values: {context: '{}'}, attachments: []}, submission: {id: 'operation', source: {kind: 'conversation', ownerId: 'operation', id: 'operation'}}}};
        await port.start(input);
        await vi.waitFor(async () => expect(await port.inspect(input)).toMatchObject({state: 'succeeded', output: result, sessionId: expect.any(String)}), {timeout: 5000});
    } finally {await runtime.dispose();}
}, 15000);

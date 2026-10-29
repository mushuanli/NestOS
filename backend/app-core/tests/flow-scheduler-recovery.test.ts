import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {FlowCommand, type FlowRevision} from '@itookit/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
it('reattaches an admitted Flow scheduler after restart and continues once after its original input is answered', async () => {
    const backend = new MemoryBackend(); vi.spyOn(backend, 'close').mockResolvedValue(undefined);
    const first = await createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false}); cleanup.push(() => first.dispose());
    const id = await first.sessionRepository.createSession('Recovery fixture');
    await first.commandBus.execute(SessionCommand.Bind, {sessionId: id});
    await first.commandBus.execute(FlowLibraryCommand.Restore, {templates: [{id: 'recover-input', name: 'Recover input', draftVersion: 1, updatedAt: 0, layout: {},
        nodes: [{id: 'review', name: 'Review', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {}, config: {fields: {answer: {type: 'string', required: true}}}},
            {id: 'after', name: 'After review', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'AFTER_REVIEW'}}],
        edges: [{id: 'continue', from: 'review', to: 'after', kind: 'control'}]}]});
    const flow = await first.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, {id: 'recover-input'});
    const run = await first.commandBus.execute<{taskId: string}>(FlowCommand.RunStart, {sessionId: id, flow});
    let inputId = '';
    await vi.waitFor(async () => {
        const tasks = await first.kernel.kernel.listSessionTasks(id);
        inputId = tasks.find(task => task.rootTaskId === run.taskId && task.interactions['input-1']?.status === 'pending')?.id ?? '';
        expect(inputId).not.toBe('');
    });
    // Model a restart after the prior scheduler lease has expired, without extending test timeouts.
    const session = await first.kernel.kernel.openSession(id), key = `flow.run.${run.taskId}.scheduler-owner`;
    const lease = await session.getShared(key);
    await session.setShared(key, {...lease!.value as object, expiresAt: 0}, {expectedVersion: lease!.version});
    await first.dispose();
    const restored = await createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false}); cleanup.push(() => restored.dispose());
    await (await restored.kernel.kernel.openTask(inputId)).respond({interactionId: 'input-1', value: {answer: 'Confirmed'}});
    const exit = await (await restored.kernel.kernel.openTask(run.taskId)).wait({until: 'settled', timeoutMs: 5000});
    expect(exit.status).toBe('succeeded');
    const tasks = await restored.kernel.kernel.listSessionTasks(id);
    expect(tasks.filter(task => task.labels?.flowNodeId === 'review')).toHaveLength(1);
    expect(tasks.filter(task => task.labels?.flowNodeId === 'after')).toHaveLength(1);
    expect(tasks.find(task => task.id === inputId)?.interactions['input-1'].status).toBe('resolved');
}, 15000);

import { expect, it, vi } from 'vitest';
import { Kernel, type EffectExecutionContext } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { HarnessProgram, HarnessExecutionEffect } from '@itookit/kernel-adapters';
import type { HarnessExecutionRequest } from '@itookit/kernel-adapters/contracts';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms } from '@itookit/llm-flow';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';

const connection = { version: 1 as const, revision: 1, id: 'remote', name: 'Remote', kind: 'harness' as const,
    nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: { root: '/workspace' } };

async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) });
    registerDurablePrograms(kernel); kernel.registerProgram(new HarnessProgram());
    const execute = vi.fn(async (_request: HarnessExecutionRequest, context: EffectExecutionContext) => {
        expect(context.grants.map(grant => grant.resource.kind)).toEqual(['harness']);
        return { text: 'Remote review complete', sessionId: 'native-session', turnId: 'native-turn' };
    });
    kernel.registerEffect(new HarnessExecutionEffect({execute,
        cancel: async (_request, context) => ({status: 'stopped', cleanup: 'confirmed', evidence: {
            sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'terminal'}}),
        reconcile: async (_request, context) => ({status: 'not-started', evidence: {
            sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'not-started'}}),
    }));
    await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    return { kernel, execute, close: async () => { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); } };
}

it('submits an ordinary remote Agent through the Session coordinator with only a harness grant', async () => {
    const { kernel, execute, close } = await fixture();
    try {
        const resolveTools = vi.fn(), resolveHarnessToolIds = vi.fn();
        const coordinator = new ConversationRunCoordinator({ kernel, resolveTools, resolveHarnessToolIds,
            engine: {}, eventBus: {}, dagPlugins: createBuiltinDagPluginRegistry() } as never);
        const run = await (coordinator as any).directTask({ roundId: 'round',
            task: { sessionId: 's', input: { text: 'Review', files: [], sendIntent: { execution: { kind: 'agent', mode: 'agent' } } },
                abortController: new AbortController() },
            config: { id: 'reviewer', execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: connection,
                capabilityPolicy: { toolIds: ['Bash'] } } }, { canonicalMessages: [{ role: 'user', content: 'Review' }] });
        const exit = await run.root.wait({ timeoutMs: 3000 });
        expect(exit).toMatchObject({ status: 'succeeded', output: { message: { role: 'assistant', content: 'Remote review complete' } } });
        expect(execute).toHaveBeenCalledOnce();
        expect(resolveTools).not.toHaveBeenCalled();
        expect(resolveHarnessToolIds).not.toHaveBeenCalled();
        expect((await kernel.listSessionTasks('s')).map(task => task.program.kind)).toEqual(['kernel-adapters.harness']);
    } finally { await close(); }
});

it('runs a native Flow remote node after its dependency and publishes the remote result', async () => {
    const { kernel, execute, close } = await fixture();
    const resolveTools = vi.fn();
    const executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), resolveTools });
    try {
        const run = await executor.submit('s', { nodes: [
            { id: 'source', name: 'Source', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: { value: 'Upstream evidence', outputName: 'result', type: 'text' } },
            { id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, capabilities: ['Bash'],
                config: { execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: connection,
                    instruction: 'Review' } },
        ], edges: [{ id: 'input', from: 'source', to: 'remote', output: 'result', input: 'evidence' }] });
        expect(await run.root.wait({ timeoutMs: 5000 })).toMatchObject({ status: 'succeeded' });
        const output = (await run.nodes.get('remote')!.status()).task.output;
        expect(output).toMatchObject({ outputs: { result: { type: 'text', content: 'Remote review complete' } } });
        expect(execute.mock.calls[0][0].prompt).toContain('Upstream evidence');
        expect(resolveTools).not.toHaveBeenCalled();
        expect((await kernel.listSessionTasks('s')).map(task => task.program.kind)).not.toContain('llm.agent');
    } finally { await executor.waitIdle(); await close(); }
});

it('keeps a local model coordinator while executing only the selected frozen remote member', async () => {
    const { kernel, execute, close } = await fixture();
    const model = vi.fn(async () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify([{ agentId: 'reviewer', instruction: 'Review the remote project' }]) } }] }));
    kernel.registerEffect({ kind: 'llm.chat', version: '1', execute: model });
    const executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
    try {
        const run = await executor.submit('s', { nodes: [{ id: 'host', name: 'Host', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            inputs: {}, capabilities: [], config: { connectionId: 'model', approval: 'none', instruction: 'Select a member', delegation: {
                enabled: true, agents: [{ agentId: 'reviewer' }], fanout: { maxTasks: 1, maxDepth: 1 }, resolvedTemplates: {
                    reviewer: { plugin: 'builtin.agent', pluginVersion: '1.0.0', capabilities: [], config: {
                        agentId: 'reviewer', execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: connection,
                        messages: [{ role: 'system', content: 'Review policy' }] } },
                },
            } } }], edges: [] });
        expect(await run.root.wait({ timeoutMs: 5000 })).toMatchObject({ status: 'succeeded' });
        expect(model).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
        const kinds = (await kernel.listSessionTasks('s')).map(task => task.program.kind);
        expect(kinds.filter(kind => kind === 'llm.agent')).toHaveLength(1);
        expect(kinds.filter(kind => kind === 'kernel-adapters.harness')).toHaveLength(1);
        expect(execute.mock.calls[0][0].prompt).toContain('Review the remote project');
    } finally { await executor.waitIdle(); await close(); }
});

it('rejects an invalid remote Flow timeout before acquiring a native turn', async () => {
    const { kernel, execute, close } = await fixture();
    const executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
    try {
        const run = await executor.submit('s', { nodes: [{ id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { execution: { kind: 'harness', connectionId: 'remote' }, harnessConnection: connection, instruction: 'Review', timeoutMs: 0 } }], edges: [] });
        expect(await run.root.wait({ timeoutMs: 3000 })).toMatchObject({ status: 'failed' });
        expect(execute).not.toHaveBeenCalled();
        expect((await run.nodes.get('remote')!.status()).task.exit?.error?.message).toContain('HARNESS_TIMEOUT_INVALID');
    } finally { await executor.waitIdle(); await close(); }
});

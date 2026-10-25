import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '@itookit/durable-kernel';
import { createBuiltinDagPluginRegistry } from '../src/flow';
import { FlowTaskFactory } from '../src/flow/task-factory';
import { prepareDispatch } from '../src/flow/structured/prepare';
import { FlowDispatchProgram } from '../src/flow/structured/dispatch';
import type { DispatchInput } from '../src/flow/structured/types';

const connection = { version: 1, kind: 'harness', id: 'frozen-endpoint' };

async function prepared(kind: string, explicit = false): Promise<DispatchInput> {
    return prepareDispatch({ mode: 'exclusive', maxRounds: 1, context: { history: 'none' },
        until: { kind: 'literal', value: false }, invocationNamespace: 'route', dependencies: [], values: {},
        branches: [{ key: 'worker', input: { request: { kind: 'literal', value: 'Review ${param.secret}' } }, instruction: 'Check round ${iteration.round}',
            ...(explicit ? { context: { history: 'explicit' as const, messages: [{ role: 'user' as const, content: 'DECLARED_HISTORY' }] } } : {}),
            target: { id: 'worker', name: 'Worker', plugin: 'builtin.agent', pluginVersion: '1.0.0',
                inputs: { connection: 'business-value', messages: 'business-messages' },
                config: { systemPrompt: ['WORKER_POLICY'], messages: [{ role: 'user', content: 'OLD_TEMPLATE_HISTORY' }] } } }],
    }, { plugins: createBuiltinDagPluginRegistry(), bind: async node => node,
        task: async node => ({ program: { kind, version: '1' }, input: {
            connection, messages: (node.config as Record<string, unknown>).messages,
            memoryPolicy: { namespaceId: 'old' }, sessionContext: { projectInstructions: 'OLD_PROJECT' },
            includeDependencyOutputs: true, dependencyBindings: [{ taskId: 'old' }],
        } } as TaskSpec),
    });
}

function spawn(input: DispatchInput): TaskSpec {
    const action = new FlowDispatchProgram().init(input).actions?.find(action => action.type === 'spawn');
    if (!action || action.type !== 'spawn') throw new Error('Expected worker spawn');
    return action.spec;
}

describe('structured conversational worker input', () => {
    it.each(['llm.agent', 'llm.chat', 'kernel-adapters.harness'])('assembles %s instructions without merging arguments into execution configuration', async kind => {
        const input = await prepared(kind), before = structuredClone(input);
        const task = spawn(input), value = task.input as Record<string, unknown>;
        expect(value.connection).toEqual(connection);
        expect(value.messages).toEqual([
            { role: 'system', content: 'WORKER_POLICY' },
            { role: 'system', content: 'Check round 1' },
            { role: 'user', content: JSON.stringify({ connection: 'business-value', messages: 'business-messages', request: 'Review ${param.secret}' }) },
        ]);
        expect(value).toMatchObject({ includeDependencyOutputs: false, dependencyBindings: [] });
        expect(value).not.toHaveProperty('memoryPolicy');
        expect(value).not.toHaveProperty('sessionContext');
        expect(JSON.stringify(value)).not.toContain('OLD_');
        expect(input).toEqual(before);
    });

    it('includes only declared history for a Harness worker and freezes the output instruction', async () => {
        const input = await prepared('kernel-adapters.harness', true);
        input.branches[0].outputSchema = { type: 'object', properties: { result: { type: 'string' } } };
        const value = spawn(input).input as { messages: Array<{ role: string; content: string }> };
        expect(value.messages[2]).toEqual({ role: 'user', content: 'DECLARED_HISTORY' });
        expect(value.messages.at(-1)?.content).toContain('Return only a JSON result matching the schema');
        expect(value.messages.at(-1)?.content).toContain(JSON.stringify(input.branches[0].outputSchema));
    });
});

it('uses the real builtin Agent plugin and factory for a Harness route worker', async () => {
    const plugins = createBuiltinDagPluginRegistry(), factory = new FlowTaskFactory({
        sessionId: 's', plugins, contextProgramVersion: '2',
    });
    const input = await prepared('kernel-adapters.harness');
    input.branches[0].target.config = { systemPrompt: ['HOST_POLICY'],
        execution: { kind: 'harness', connectionId: connection.id }, harnessConnection: connection };
    const frozen = await prepareDispatch(input, { plugins, bind: async node => node, task: async node => {
        const runtime = await plugins.loadRuntime(node.plugin, node.pluginVersion);
        return factory.create(node, runtime.createTask({ config: node.config, inputs: node.inputs,
            dependencies: [], sessionId: 's', nodeRunId: node.id }), []);
    } });
    const task = spawn(frozen);
    expect(task.program).toEqual({ kind: 'kernel-adapters.harness', version: '1' });
    expect(task.deferStart).toBe(true);
    expect(task.input).toMatchObject({ connection, includeDependencyOutputs: false,
        messages: [{ role: 'system', content: 'HOST_POLICY' }, { role: 'system', content: 'Check round 1' },
            { role: 'user', content: JSON.stringify({ connection: 'business-value', messages: 'business-messages', request: 'Review ${param.secret}' }) }] });
});

it('assembles a Harness revision worker through the same dispatch protocol', async () => {
    const input = await prepared('kernel-adapters.harness');
    input.maxRounds = 2;
    input.revision = { fields: { request: { type: 'string' } },
        invocation: { ...structuredClone(input.branches[0]), key: 'revise', instruction: 'Revise round ${iteration.round}' } };
    const program = new FlowDispatchProgram(), first = program.init(input);
    const next = program.reduce(first.state, { type: 'task-exited', taskId: 'worker-task', spawnKey: '1:worker',
        exit: { status: 'succeeded', output: { result: 'reviewed' } } });
    const action = next.actions?.find(action => action.type === 'spawn');
    if (!action || action.type !== 'spawn') throw new Error('Expected revision worker');
    expect(action.spawnKey).toBe('1:revise');
    expect(action.spec.input).toMatchObject({ connection, includeDependencyOutputs: false });
    expect((action.spec.input as { messages: unknown[] }).messages[1]).toEqual({ role: 'system', content: 'Revise round 1' });
});

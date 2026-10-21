import { expect, it } from 'vitest';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';
import { compileReferenceGraph, resolveExecutionNode } from '../src/flow/structured/references';
import type { DagNodeDefinition } from '../src/contracts';

it('resolves declared multimodal messages once while leaving saved messages literal', async () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.test/image.png' } };
    const audio = { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } };
    const node: DagNodeDefinition = { id: 'agent', name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
        invocationContext: 'isolated', messages: [{ role: 'user', content: 'BOUND_HISTORY' }],
        messageTemplates: [{ role: 'user', content: [{ type: 'text', text: '${param.caption}' }] },
            { role: 'user', content: '${param.attachments}' }],
    } };
    const resolved = resolveExecutionNode(node, { param: { caption: 'Keep ${param.secret}', attachments: [image, audio], secret: 'PRIVATE' } });
    const runtime = await createBuiltinDagPluginRegistry().loadRuntime('builtin.agent');
    const task = await runtime.createTask!({ config: resolved.config, inputs: {}, sessionId: 's', nodeRunId: 'agent' } as never);
    expect(task.input).toMatchObject({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep ${param.secret}' }] },
        { role: 'user', content: [image, audio] }] });
    expect(JSON.stringify(task.input)).not.toContain('BOUND_HISTORY');
    const literal = { ...node, config: { messages: [{ role: 'user', content: '${param.secret}' }] } };
    expect(resolveExecutionNode(literal, { param: { secret: 'PRIVATE' } }).config).toMatchObject(literal.config);
});

it('creates dependencies for message templates but does not scan literal message history', () => {
    const graph = compileReferenceGraph({ nodes: [
        { id: 'source', name: 'Source', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'hello' } },
        { id: 'agent', name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
            messages: [{ role: 'user', content: '${nodes.missing.outputs.result}' }],
            messageTemplates: [{ role: 'user', content: '${nodes.source.outputs.result}' }],
        } },
    ] as DagNodeDefinition[], edges: [] });
    expect(graph.edges).toMatchObject([{ from: 'source', to: 'agent', kind: 'control' }]);
});

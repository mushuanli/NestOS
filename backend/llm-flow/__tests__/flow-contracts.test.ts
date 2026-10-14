import { flowToDag } from '../src/flow/to-dag';
import { describe, expect, it } from 'vitest';
import { renderFlowTemplate } from '../src/contracts';
import { compileReferenceGraph, invocationReferenceContext, resolveExecutionNode, scopedParameters } from '../src/flow/structured/references';
import { compileCondition } from '../src/flow/structured/condition';
import { FlowReducerRegistry, orderedUpdates } from '../src/flow/structured/join';
import { schemaCompatibilityIssue } from '../src/flow/schema-compat';
import { flowSchemaIssue } from '../src/flow/schema-registry';
import { evaluate } from '../src/flow/operations';
import { invalidFields } from '../src/flow/structured/input';
import type { DagRunSpec } from '../src/contracts';

function graph(): DagRunSpec {
    return { nodes: [
        { id: 'input', name: 'Input', plugin: 'builtin.input', pluginVersion: '1.0.0', config: { param: { essay: { type: 'string' } } }, inputs: {} },
        { id: 'use', name: 'Use', plugin: 'builtin.transform', pluginVersion: '1.0.0', config: { value: '${param.essay}' }, inputs: {} },
    ], edges: [] };
}

describe('Flow node contracts', () => {
    it('preserves native values and treats substituted text as data, including the legacy alias', () => {
        const context = { param: { essay: '${param.secret}', secret: 'DO NOT INSERT', count: 2, settings: { ok: true } } };
        expect(renderFlowTemplate('Essay: ${param.essay}', context)).toBe('Essay: ${param.secret}');
        expect(renderFlowTemplate('${params.count}', context)).toBe(2);
        expect(renderFlowTemplate('${param.settings}', context)).toEqual({ ok: true });
        expect(() => renderFlowTemplate('${param.missing}', context)).toThrow('Missing Flow reference');
        expect(() => renderFlowTemplate('${param.constructor}', context)).toThrow('Unsafe');
    });
    it('compiles input references into dependencies and resolves the completed input snapshot', () => {
        const source = graph(); const compiled = compileReferenceGraph(source);
        expect(source.edges).toHaveLength(0);
        expect(compiled.edges).toMatchObject([{ from: 'input', to: 'use', kind: 'control' }]);
        const context = invocationReferenceContext(compiled.nodes, { input: { outputs: { result: { content: { essay: 'NEW' } } } } }, { essay: 'OLD' }, 1);
        expect(resolveExecutionNode(compiled.nodes[1], context).config).toEqual({ value: 'NEW' });
        expect(compileReferenceGraph(compiled)).toEqual(compiled);
    });
    it('rejects duplicate input producers and hidden dependency cycles', () => {
        const duplicate = graph(); duplicate.nodes.push({ ...duplicate.nodes[0], id: 'other' });
        expect(() => compileReferenceGraph(duplicate)).toThrow('Multiple input producers');
        const cyclic = graph(); cyclic.edges.push({ id: 'reverse', from: 'use', to: 'input', kind: 'control', input: 'input', output: 'result' });
        expect(() => compileReferenceGraph(cyclic)).toThrow('dependency cycle');
    });
    it('reads named output artifacts and rejects missing producers', () => {
        const source = graph(); source.nodes[1].config = { value: '${nodes.input.outputs.result.essay}' };
        expect(compileReferenceGraph(source).edges).toHaveLength(1);
        source.nodes[1].config = { value: '${nodes.unknown.outputs.result}' };
        expect(() => compileReferenceGraph(source)).toThrow('Invalid reference producer');
    });
    it('compiles all/any conditions against validated score slots and current parameters', () => {
        const condition = compileCondition({ all: [
            { value: '${state.results.content.current}', operator: 'eq', expected: true },
            { value: '${state.results.content.value.score}', operator: 'gte', expected: '${param.passScore}' },
        ] });
        expect(evaluate(condition, { results: { content: { current: true, value: { score: 9 } } }, inputs: { passScore: 9 } })).toBe(true);
        expect(evaluate(condition, { results: { content: { current: false, value: { score: 10 } } }, inputs: { passScore: 9 } })).toBe(false);
    });
    it('reduces in selected order, preserving old slots and supporting a versioned custom reducer', () => {
        const slot = (score: number) => ({ value: { score }, taskId: 'task', round: 1, inputRevision: '1' });
        const registry = new FlowReducerRegistry();
        const updates = orderedUpdates(['a', 'b'], { b: slot(8), a: slot(7) });
        expect(registry.reduce({ failure: 'fail', reducer: 'append@1' }, undefined, updates)).toEqual([slot(7), slot(8)]);
        expect(registry.reduce(undefined, { c: slot(9) }, updates)).toMatchObject({ a: slot(7), c: slot(9) });
        registry.register('count@1', (_, batch) => Object.keys(batch).length);
        expect(registry.reduce({ failure: 'fail', reducer: 'count@1' }, undefined, updates)).toBe(2);
        expect(() => registry.register('count@1', () => 0)).toThrow('duplicate');
    });
    it('isolates composite parameter bindings without interpreting substituted data twice', async () => {
        const child = { id: 'child', name: 'Child', revision: 1, createdAt: 0, digest: '', nodes: [
            { id: 'use', name: 'Use', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${param.essay}' } },
        ], edges: [], parameters: [{ name: 'essay', type: 'string' }] };
        const parent = { id: 'parent', name: 'Parent', revision: 1, createdAt: 0, digest: '', nodes: [
            { id: 'a', name: 'A', plugin: 'builtin.flow', pluginVersion: '1.0.0', inputs: {}, config: { flowId: 'child', parameters: { essay: '${params.essay}' } } },
            { id: 'b', name: 'B', plugin: 'builtin.flow', pluginVersion: '1.0.0', inputs: {}, config: { flowId: 'child', parameters: { essay: 'different' } } },
        ], edges: [] };
        const graph = await flowToDag(parent as any, undefined, undefined, async () => child as any);
        const values = scopedParameters(graph, 'a/use', { essay: '${param.secret}', secret: 'DO NOT INSERT' });
        expect(resolveExecutionNode(graph.nodes[0], { param: values }).config).toEqual({ value: '${param.secret}' });
        expect(scopedParameters(graph, 'b/use', {}).essay).toBe('different');
    });

    it('renders authored task prompts without interpreting inherited history or system instructions', () => {
        const node = { ...graph().nodes[1], plugin: 'builtin.agent', config: {
            instruction: 'Essay: ${param.essay}', systemPrompt: ['Static rubric'],
            messages: [{ role: 'user', content: '${param.secret}' }, { role: 'system', content: 'Essay: ${param.essay}' }],
        } };
        const resolved = resolveExecutionNode(node, { param: { essay: 'Essay', secret: 'PRIVATE' } }).config as any;
        expect(resolved.messages).toEqual([{ role: 'user', content: '${param.secret}' }, { role: 'user', content: 'Essay: Essay' }]);
        expect(JSON.stringify(resolved)).not.toContain('PRIVATE');
    });

    it('enforces input choices and numeric result bounds', () => {
        expect(invalidFields({ choice: { type: 'string', widget: 'select', options: ['a'] } }, { choice: 'b' })).toEqual(['choice']);
        expect(flowSchemaIssue({ type: 'number', minimum: 0, maximum: 10 }, 11)).toContain('outside range');
        expect(flowSchemaIssue({ type: 'number', minimum: 0, maximum: 10 }, 9)).toBeUndefined();
        expect(schemaCompatibilityIssue({ type: 'number' }, { type: 'number', maximum: 10 })).toContain('maximum');
        expect(schemaCompatibilityIssue({ type: 'number', maximum: 9 }, { type: 'number', maximum: 10 })).toBeUndefined();
    });
});

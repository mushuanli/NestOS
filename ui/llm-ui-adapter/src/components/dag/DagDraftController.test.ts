import { describe, expect, it } from 'vitest';
import type { DagPluginManifest, FlowDraft, FlowEdgeId } from '@itookit/llm-flow/contracts';
import {
    DagDraftController,
    createFlowEdge,
} from './DagDraftController';
import { validateSchema } from './SchemaForm';

function draft(): FlowDraft {
    return {
        id: 'flow' as FlowDraft['id'],
        draftVersion: 1,
        name: 'Flow',
        nodes: [],
        edges: [],
        layout: {},
        updatedAt: 1,
    };
}

describe('DagDraftController', () => {
    it('adds a tool input and its data edge as one undoable change', () => {
        const controller = new DagDraftController(draft());
        const target = controller.addNode(manifests()[0]);
        const descriptor = {...manifests()[0], id: 'builtin.tool', kind: 'tool'} as DagPluginManifest;
        const source = controller.addToolSource(descriptor, {toolId: 'mcp__knowledge__search', toolVersion: '1', args: {query: 'recent'}}, target.id);
        expect(controller.value.edges).toContainEqual(expect.objectContaining({from: source.id, to: target.id, input: 'input', output: 'result'}));
        expect(source.capabilities).toEqual(['mcp__knowledge__search']);
        controller.undo();
        expect(controller.value.nodes).toEqual([target]);
        expect(controller.value.edges).toEqual([]);
    });
    it('creates all six built-in nodes from serializable manifests', () => {
        const controller = new DagDraftController(draft());
        manifests().forEach(item => controller.addNode(item));
        expect(controller.value.nodes.map(node => node.plugin.split('.').at(-1))).toEqual([
            'agent', 'route', 'transform', 'reduce', 'human', 'spawn',
        ]);
        expect(controller.value.nodes.every(node => node.pluginVersion === '1.0.0')).toBe(true);
    });

    it('duplicates without edges and deletes incident edges atomically', () => {
        const controller = new DagDraftController(draft());
        const transform = manifests().find(item => item.kind === 'transform')!;
        const first = controller.addNode(transform);
        const second = controller.addNode(transform);
        controller.addEdge(createFlowEdge(first, second, 'data', {
            output: 'result',
            input: 'input',
        }));
        const copy = controller.duplicateNode(first.id);
        expect(controller.value.edges).toHaveLength(1);
        expect(copy.id).not.toBe(first.id);
        expect(controller.deleteNode(second.id).incidentEdgeCount).toBe(1);
        expect(controller.value.edges).toHaveLength(0);
    });

    it('allows back edges (loops) but rejects self-edges', () => {
        const controller = new DagDraftController(draft());
        const routeKind = manifests().find(item => item.kind === 'route')!;
        const transformKind = manifests().find(item => item.kind === 'transform')!;
        const route = controller.addNode(routeKind);
        const target = controller.addNode(transformKind);
        const edge = createFlowEdge(route, target, 'control');
        controller.addEdge(edge);
        controller.updateNode({
            ...route,
            config: {
                mode: 'fallback',
                rules: [],
                defaultEdgeId: edge.id,
            },
        });
        // Back edges form a loop and are now legal (loop is a runtime feature).
        expect(() => controller.addEdge(createFlowEdge(target, route, 'control'))).not.toThrow();
        // Self-edges remain forbidden.
        expect(() => controller.addEdge(createFlowEdge(target, target, 'control'))).toThrow(/Self edges/);
        controller.deleteEdge(edge.id as FlowEdgeId);
        expect(controller.value.nodes[0].config).toHaveProperty('defaultEdgeId', edge.id);
    });

    it('supports undo/redo and nested schema validation', () => {
        const controller = new DagDraftController(draft());
        controller.addNode(manifests()[0]);
        expect(controller.undo()).toBe(true);
        expect(controller.value.nodes).toHaveLength(0);
        expect(controller.redo()).toBe(true);
        const schema = { type: 'object', required: ['mode'], properties: {
            mode: { type: 'string', enum: ['a', 'b'] },
            children: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
        } };
        expect(validateSchema(schema, { mode: 'c', children: [{}] })).toEqual([
            '$.mode is not an allowed value',
            '$.children[0].id is required',
        ]);
    });


});

function manifests(): DagPluginManifest[] {
    return ['agent', 'route', 'transform', 'reduce', 'human', 'spawn']
        .map(kind => ({
            id: `builtin.${kind}`,
            version: '1.0.0',
            kind,
            title: kind,
            category: 'Test',
            configSchema: { type: 'object' },
            defaultConfig: {},
            inputs: [{ name: 'input', cardinality: 'many', required: false, order: 0 }],
            outputs: [{ name: 'result', required: false, order: 0 }],
        }));
}

import { validateVariableGraph, nodeUsesVariables } from '../variables';
import { prepareFlowParameters } from '../parameters';
import { flowTemplateReferences, renderFlowTemplate, renderFlowText, type FlowTemplateContext } from '../../contracts';
import type { DagNodeDefinition, DagEdgeDefinition, DagRunSpec, JsonValue } from '../../contracts';
import { extractNodeOutput } from '@itookit/llm-tasks';
import { findCycles } from '../graph';
import { object } from './value';

type Graph = { variables?: import('../../contracts').FlowVariables; nodes: DagNodeDefinition[]; edges: Array<Omit<DagEdgeDefinition, 'input' | 'output'> & { input?: string; output?: string }> };

/** References create explicit scheduling dependencies without injecting extra model history. */
export function compileReferenceGraph<T extends Graph>(source: T): T {
    const graph = structuredClone(source);
    for (const node of graph.nodes) node.config = normalizePrompts(node.config);
    for (const node of graph.nodes) if (node.plugin === 'builtin.input') {
        const config = object(node.config);
        if (config.param && config.fields) throw new Error('Input declares both param and fields');
        if (config.param) { config.fields = config.param; delete config.param; node.config = config; }
    }
    for (const scope of new Set(graph.nodes.map(node => nodeScope(node.id)))) inputProducers(graph.nodes, scope);
    const oldBackEdges = findCycles(source.nodes, source.edges as DagEdgeDefinition[]).backEdges;
    for (const node of graph.nodes) for (const ref of flowTemplateReferences([withoutHistory(node.config), node.inputs, node.assign, ...(nodeUsesVariables(node, graph.variables ?? {}) ? Object.values(graph.variables ?? {}).map(value => value.initial) : [])])) {
        const id = ref.root === 'nodes' ? ref.path[0] : ref.root === 'param' ? inputProducers(graph.nodes, nodeScope(node.id)).get(ref.path[0]) : undefined;
        if (!id || id === node.id && ref.root === 'param') continue;
        if (!graph.nodes.some(item => item.id === id) || id === node.id) throw new Error(`Invalid reference producer: ${id}`);
        if (ref.root === 'nodes' && nodeScope(id) !== nodeScope(node.id) && !graph.edges.some(edge => edge.from === id && edge.to === node.id)) throw new Error('Cross-scope references require explicit ports');
        if (ref.root === 'nodes' && (ref.path[1] !== 'outputs' || !ref.path[2])) throw new Error('Node references require nodes.id.outputs.port');
        if (!graph.edges.some(edge => edge.from === id && edge.to === node.id)) graph.edges.push({
            id: `reference:${id}:${node.id}`, from: id, to: node.id, kind: 'control',
        });
    }
    const cycles = findCycles(graph.nodes, graph.edges as DagEdgeDefinition[]).backEdges;
    if ([...cycles].some(id => !oldBackEdges.has(id))) throw new Error('Flow references introduce a dependency cycle');
    validateVariableGraph(graph as DagRunSpec);
    return { ...graph, templateVersion: 1 };
}

export function inputProducers(nodes: DagNodeDefinition[], scope = ''): Map<string, string> {
    const producers = new Map<string, string>();
    for (const node of nodes.filter(node => node.plugin === 'builtin.input' && nodeScope(node.id) === scope)) {
        for (const key of Object.keys(object(object(node.config).fields ?? object(node.config).param))) {
            if (producers.has(key)) throw new Error(`Multiple input producers for param.${key}`);
            producers.set(key, node.id);
        }
    }
    return producers;
}

export function invocationReferenceContext(nodes: DagNodeDefinition[], outputs: Record<string, unknown>, parameters: Record<string, unknown>, round: number, consumerId = ''): FlowTemplateContext {
    const param = { ...parameters };
    for (const [key, id] of inputProducers(nodes, nodeScope(consumerId))) if (Object.hasOwn(outputs, id)) {
        const value = object(extractNodeOutput(outputs[id], 'result'));
        if (Object.hasOwn(value, key)) param[key] = value[key];
    }
    const visible = Object.fromEntries(Object.entries(outputs).map(([id, output]) => {
        const artifacts = object(object(output).outputs);
        const ports = Object.keys(artifacts).length ? Object.keys(artifacts) : ['result'];
        return [id, { outputs: Object.fromEntries(ports.map(port => [port, extractNodeOutput(output, port)])) }];
    }));
    return { param, nodes: visible, iteration: { round } };
}

export function resolveExecutionNode(node: DagNodeDefinition, context: FlowTemplateContext): DagNodeDefinition {
    if (node.plugin === 'builtin.route' && node.pluginVersion === '2.0.0') {
        const { branches, invocationDefaults, until, revision, ...config } = object(node.config);
        return { ...node, config: { ...object(renderFlowTemplate(config, context)), branches: resolveBranchSettings(branches, context),
            ...(revision ? { revision: { ...object(revision), ...(object(revision).invocation ? {
                invocation: (resolveBranchSettings([object(revision).invocation], context) as unknown[])[0],
            } : {}) } } : {}), invocationDefaults, until: renderFlowTemplate(until, context), referenceNodes: context.nodes, ...(context.vars ? { variableValues: context.vars, initialParameters: context.param } : {}) },
            inputs: { ...context.param, ...object(renderFlowTemplate(node.inputs, context)) } };
    }
    return { ...node, config: renderNodeConfig(node.config, context), inputs: object(renderFlowTemplate(node.inputs, context)) };
}

function normalizePrompts(value: unknown, key = ''): unknown {
    if (typeof value === 'string' && key === 'prompt') return value.replace(/\$\{params\./g, '${param.');
    if (Array.isArray(value)) return value.map(item => normalizePrompts(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizePrompts(item, name)]));
    return value;
}

function resolveBranchSettings(value: unknown, context: FlowTemplateContext): unknown {
    if (!Array.isArray(value)) return value;
    return value.map(branch => {
        const target = object(branch.target), config = object(target.config);
        const { systemPrompt, instruction, ...settings } = config;
        return { ...branch, input: renderFlowTemplate(branch.input, context), target: { ...target,
            config: { ...object(renderFlowTemplate(settings, context)), ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(instruction !== undefined ? { instruction } : {}) },
        } };
    });
}

function nodeScope(id: string): string { return id.slice(0, id.lastIndexOf('/') + 1); }

function renderNodeConfig(value: unknown, context: FlowTemplateContext): unknown {
    const config = object(value);
    const { prompt, instruction, messages, systemPrompt, sessionContext, ...rest } = config;
    return { ...object(renderFlowTemplate(rest, context)),
        ...(messages !== undefined ? { messages: invocationMessages(messages, prompt ?? instruction, context) } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(sessionContext !== undefined ? { sessionContext } : {}),
        ...(prompt !== undefined ? { prompt: typeof prompt === 'string' ? renderFlowText(prompt, context) : prompt } : {}),
        ...(instruction !== undefined ? { instruction: typeof instruction === 'string' ? renderFlowText(instruction, context) : instruction } : {}),
    };
}

/** Resolve each lexical scope once; substituted values are data in all descendant templates. */
export function scopedParameters(spec: DagRunSpec, nodeId: string, root: Record<string, JsonValue>, outputs: Record<string, unknown> = {}): Record<string, JsonValue> {
    const scopes = spec.parameterScopes ?? {};
    const key = Object.keys(scopes).filter(prefix => nodeId.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
    const visit = (id: string, seen: Set<string>): Record<string, JsonValue> => {
        if (!id) return root;
        if (seen.has(id) || !scopes[id]) throw new Error('Invalid parameter scope');
        seen.add(id);
        const scope = scopes[id], parent = visit(scope.parent, seen);
        if (scope.source) {
            if (!Object.hasOwn(outputs, scope.source)) throw new Error(`Missing Flow call input: ${scope.source}`);
            const supplied = object(extractNodeOutput(outputs[scope.source], 'result')) as Record<string, JsonValue>;
            const allowed = new Set((scope.schema ?? []).map(field => field.name));
            for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw new Error(`Unknown Flow parameter: ${key}`);
            return prepareFlowParameters(scope.schema, { ...scope.defaults, ...supplied });
        }
        const values = { ...parent, ...scope.defaults, ...object(renderFlowTemplate(scope.values, { param: parent })) } as Record<string, JsonValue>;
        return prepareFlowParameters(scope.schema, values);
    };
    return key ? visit(key, new Set()) : root;
}

function withoutHistory(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutHistory);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['messages', 'systemPrompt', 'sessionContext'].includes(key)).map(([key, item]) => [key, withoutHistory(item)]));
}
function invocationMessages(messages: unknown, prompt: unknown, context: FlowTemplateContext): unknown {
    if (!Array.isArray(messages) || typeof prompt !== 'string' || !flowTemplateReferences(prompt).length) return messages;
    const retained = messages.filter((value, index) => {
        const message = object(value);
        return !(message.content === prompt && (message.role === 'system' || index === messages.length - 1));
    });
    return [...retained, { role: 'user', content: renderFlowText(prompt, context) }];
}

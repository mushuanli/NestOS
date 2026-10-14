import type { FlowRevision, FlowNodeDefinition, JsonValue, DagNodeOutcome } from '../contracts';
import { assertFlowSchema, flowSchemaIssue } from './schema-registry';

export const RETURN_NODE = '__flow_return';

/** Compile authored returns before reference analysis so dependencies remain explicit. */
export function withFlowReturns(flow: FlowRevision): FlowRevision {
    if (!flow.outputs) return flow;
    if (!Object.keys(flow.outputs).length) throw new Error('Flow outputs must not be empty');
    if (flow.nodes.some(node => node.id === RETURN_NODE)) throw new Error(`Reserved node id: ${RETURN_NODE}`);
    for (const [name, output] of Object.entries(flow.outputs)) {
        if (!/^[A-Za-z][\w-]*$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) throw new Error(`Invalid Flow output: ${name}`);
        if (!output || !Object.hasOwn(output, 'value')) throw new Error(`Flow output requires value: ${name}`);
        if (output.schema !== undefined) assertFlowSchema(output.schema);
    }
    const node: FlowNodeDefinition = { id: RETURN_NODE as FlowNodeDefinition['id'], name: 'Return',
        plugin: 'builtin.return', pluginVersion: '1.0.0', inputs: {}, config: { returns: flow.outputs } };
    return { ...flow, nodes: [...flow.nodes, node], edges: [...flow.edges, ...flow.nodes.map(source => ({
        id: `return:${source.id}` as FlowRevision['edges'][number]['id'], from: source.id, to: node.id, kind: 'control' as const,
    }))] };
}

export function returnOutcome(returns: JsonValue | undefined): DagNodeOutcome {
    if (!returns || Array.isArray(returns) || typeof returns !== 'object') throw new Error('Invalid Flow returns');
    const outputs: DagNodeOutcome['outputs'] = {};
    for (const [name, raw] of Object.entries(returns)) {
        const item = raw as { value: JsonValue; schema?: JsonValue };
        const issue = item.schema === undefined ? undefined : flowSchemaIssue(item.schema, item.value);
        if (issue) throw new Error(`Invalid Flow return ${name}: ${issue}`);
        outputs[name] = { outputName: name, type: 'json', content: item.value };
    }
    return { outputs };
}

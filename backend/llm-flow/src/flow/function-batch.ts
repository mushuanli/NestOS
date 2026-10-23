import { extractNodeOutput } from '@itookit/llm-tasks';
import { remapFlowNodeReferences, type DagNodeDefinition, type DagRunSpec, type GraphPatch, type JsonValue } from '../contracts';
import { RETURN_NODE } from './function-outputs';
import { namespaceCallConfig } from './function-namespace';
import { flowParameterValues, validateFlowParameters } from './parameters';

type Template = NonNullable<DagRunSpec['functionCalls']>[string];
export type CompiledCallScopes = Pick<DagRunSpec, 'parameterScopes' | 'variableScopes' | 'nodeDefaults' | 'nodeConnections' | 'functionCalls'>;
export interface ExpandedFunctionCalls { patch: GraphPatch; scopes: CompiledCallScopes; results: JsonValue[]; count: number }

/** Include frozen templates in catalog admission before the first input task executes. */
export function functionTemplateNodes(spec: DagRunSpec): DagNodeDefinition[] {
    return [...spec.nodes, ...Object.values(spec.functionCalls ?? {}).flatMap(template => functionTemplateNodes(template.child))];
}

/** Build the whole deterministic batch before publishing any graph mutation. */
export function expandFunctionCalls(spec: DagRunSpec, inputId: string, output: unknown, currentCount: number, maxNodes: number): ExpandedFunctionCalls | undefined {
    const template = spec.functionCalls?.[inputId];
    if (!template || output === undefined) return;
    const input = object(extractNodeOutput(output, 'result'));
    const rows = validateRows(template, input, currentCount, maxNodes);
    const patch: GraphPatch = { idempotencyKey: `function-calls:${inputId}`, nodes: [], edges: [] };
    const scopes: CompiledCallScopes = { parameterScopes: {}, variableScopes: {}, nodeDefaults: {}, nodeConnections: {}, functionCalls: {} };
    const results: JsonValue[] = [];
    for (let index = 0; index < rows.length; index++) appendCall(template, inputId, index, patch, scopes, results);
    return { patch, scopes, results, count: rows.length };
}

function validateRows(template: Template, input: Record<string, unknown>, currentCount: number, maxNodes: number): unknown[] {
    if (!Array.isArray(input.parameterSets)) throw new Error('Flow call parameterSets must be an array');
    const rows = input.parameterSets, count = currentCount + rows.length * template.child.nodes.length;
    if (!Number.isSafeInteger(count) || count > maxNodes) throw new Error(`Flow call node limit exceeded: ${count}/${maxNodes}`);
    const names = new Set((template.child.parameterSchema ?? []).map(field => field.name));
    for (const [index, row] of rows.entries()) {
        if (!isObject(row)) throw new Error(`Flow call parameterSets[${index}] must be an object`);
        const supplied = { ...object(input.parameters), ...row } as Record<string, JsonValue>;
        const unknown = Object.keys(supplied).find(key => !names.has(key));
        if (unknown) throw new Error(`Flow call parameterSets[${index}]: Unknown Flow parameter: ${unknown}`);
        const issues = validateFlowParameters(template.child.parameterSchema, supplied, template.child.inputGroups);
        if (issues.length) throw new Error(`Flow call parameterSets[${index}]: ${issues.map(issue => issue.message).join('; ')}`);
    }
    return rows;
}

function appendCall(template: Template, inputId: string, index: number, patch: GraphPatch, scopes: CompiledCallScopes, results: JsonValue[]): void {
    const callId = template.collector.slice(0, -RETURN_NODE.length - 1), prefix = `${callId}/${index}/`;
    const child = template.child, aliases = Object.fromEntries(child.nodes.map(node => [node.id, prefix + node.id]));
    patch.nodes.push(...child.nodes.map(node => cloneNode(node, child, prefix, aliases)));
    patch.edges.push(...child.edges.map(edge => ({ ...edge, id: prefix + edge.id, from: prefix + edge.from, to: prefix + edge.to })));
    appendBarriers(template, inputId, index, prefix, patch);
    appendScopes(child, inputId, index, prefix, callId, scopes);
    const returns = object(object(child.nodes.find(node => node.id === RETURN_NODE)?.config).returns);
    results.push(Object.fromEntries(Object.keys(returns).map(name => [name, `\${nodes.${prefix}${RETURN_NODE}.outputs.${name}}`])));
}

function cloneNode(node: DagNodeDefinition, child: DagRunSpec, prefix: string, aliases: Record<string, string>): DagNodeDefinition {
    return { ...structuredClone(node), id: prefix + node.id, name: `${prefix}${node.name}`,
        config: namespaceCallConfig(node, child, prefix, aliases),
        inputs: remapFlowNodeReferences(node.inputs, aliases) as Record<string, unknown>,
        assign: remapFlowNodeReferences(node.assign, aliases) as typeof node.assign,
        ...(node.compensate && aliases[node.compensate] ? { compensate: aliases[node.compensate] } : {}) };
}

function appendBarriers(template: Template, inputId: string, index: number, prefix: string, patch: GraphPatch): void {
    const previous = index - template.maxConcurrency;
    const previousReturn = `${template.collector.slice(0, -RETURN_NODE.length - 1)}/${previous}/${RETURN_NODE}`;
    for (const node of template.child.nodes) {
        patch.edges.push(control(`${prefix}input:${node.id}`, inputId, prefix + node.id));
        if (previous >= 0) patch.edges.push(control(`${prefix}lane:${node.id}`, previousReturn, prefix + node.id));
    }
    patch.edges.push(control(`${prefix}collect`, prefix + RETURN_NODE, template.collector));
}

function appendScopes(child: DagRunSpec, inputId: string, index: number, prefix: string, callId: string, scopes: CompiledCallScopes): void {
    scopes.parameterScopes![prefix] = { source: inputId, parameterSet: index, parent: callId.slice(0, callId.lastIndexOf('/') + 1),
        defaults: flowParameterValues(child.parameterSchema), values: {}, schema: structuredClone(child.parameterSchema), groups: structuredClone(child.inputGroups) };
    scopes.variableScopes![prefix] = structuredClone(child.variables ?? {});
    for (const [id, scope] of Object.entries(child.parameterScopes ?? {})) scopes.parameterScopes![prefix + id] = {
        ...structuredClone(scope), parent: prefix + scope.parent, ...(scope.source ? { source: prefix + scope.source } : {}) };
    for (const [id, variables] of Object.entries(child.variableScopes ?? {})) scopes.variableScopes![prefix + id] = structuredClone(variables);
    for (const [id, defaults] of Object.entries(child.nodeDefaults ?? {})) scopes.nodeDefaults![prefix + id] = structuredClone(defaults);
    for (const [id, connections] of Object.entries(child.nodeConnections ?? {})) scopes.nodeConnections![prefix + id] = structuredClone(connections);
    for (const [id, template] of Object.entries(child.functionCalls ?? {})) scopes.functionCalls![prefix + id] = { ...structuredClone(template), collector: prefix + template.collector };
}

function control(id: string, from: string, to: string) {
    return { id, from, to, kind: 'control' as const, dependencyOnly: true, input: 'input', output: 'result' };
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }

/** Diagnostics expose bounded structural categories, never supplied parameter values. */
export function functionCallFailureCategory(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('node limit exceeded')) return 'node-limit';
    if (message.includes('parameterSets')) return 'invalid-parameter-set';
    if (message.includes('idempotency conflict')) return 'changed-call-shape';
    return 'graph-validation';
}

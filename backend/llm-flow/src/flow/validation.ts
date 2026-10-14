import { createRunCatalog } from './run-catalog';
import type { DagPluginCatalog, FlowRevision, FlowConnection, JsonValue, FlowEdgeDefinition, FlowNodeDefinition } from '../contracts';
import { DELEGATION_LIMITS } from '../contracts';
import { simpleHash } from '@itookit/llm-context';
import { findCycles } from './graph';
import { validateDispatch } from './structured/validation';
import { compileReferenceGraph } from './structured/references';
import { compileDispatchGraph } from './structured/graph';
import { compileControlGraph } from './control/graph';
import { validateWaitPolicy } from './control/join-program';
import { validateFields } from './structured/input';
import { dataEdgeSchemaIssue } from './port-contract';
import { withFlowReturns } from './function-outputs';

export interface ValidationIssue {
    code: string;
    message: string;
    nodeId?: string;
    edgeId?: string;
    severity?: 'error' | 'warning';
}

export function flowRevisionDigest(flow: Omit<FlowRevision, 'digest'>): string {
    return simpleHash(canonicalJson({
        id: flow.id,
        revision: flow.revision,
        name: flow.name,
        nodes: flow.nodes,
        edges: flow.edges,
        parameters: flow.parameters,
        ...(flow.outputs ? { outputs: flow.outputs } : {}),
        ...(flow.dependencyLocks ? { dependencyLocks: flow.dependencyLocks } : {}),
        ...(flow.variables ? { variables: flow.variables } : {}),
        connections: flow.connections,
        defaultConnection: flow.defaultConnection,
        systemPrompt: flow.systemPrompt,
        toolIds: flow.toolIds,
        defaults: flow.defaults,
        runPolicy: flow.runPolicy,
    }));
}

export function validateFlowRevision(
    flow: FlowRevision,
    plugins?: DagPluginCatalog,
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    try { flow = compileReferenceGraph(withFlowReturns(compileControlGraph(compileDispatchGraph(flow)))); }
    catch (error) { return [{ code: 'invalid-dispatch-graph', message: String(error) }]; }
    if (plugins) {
        try { plugins = createRunCatalog(plugins, flow.nodes); }
        catch (error) { return [{ code: 'invalid-port-schema', message: String(error) }]; }
    }
    const nodes = validateNodes(flow.nodes, plugins, issues);
    validateCompensations(flow.nodes, nodes, issues);
    validateEdges(flow.edges, nodes, plugins, issues);
    validateAcyclic(flow.nodes, flow.edges, issues);
    validateConnections(flow.connections, flow.defaultConnection, issues);
    validateConnectionReferences(flow, issues);
    validateRunPolicy(flow, issues);
    for (const parameter of flow.parameters ?? []) {
        if (parameter.onMissing === 'interact' && !flow.nodes.some(node => node.plugin === 'builtin.input'
            && isRecord(node.config) && isRecord(node.config.fields) && Object.hasOwn(node.config.fields, parameter.name))) {
            issues.push({ code: 'missing-input-collector', message: `Interactive parameter requires an input node: ${parameter.name}` });
        }
    }
    return deduplicate(issues);
}

function validateCompensations(
    definitions: FlowNodeDefinition[],
    nodes: Map<string, FlowNodeDefinition>,
    issues: ValidationIssue[],
): void {
    for (const node of definitions) {
        if (!node.compensate) continue;
        if (node.compensate === node.id || !nodes.has(String(node.compensate))) {
            add(issues, 'invalid-compensation', `${node.id}: compensation node must reference another existing node`, String(node.id));
        }
    }
}

function validateRunPolicy(flow: FlowRevision, issues: ValidationIssue[]): void {
    const policy = flow.runPolicy;
    if (!policy) return;
    for (const field of ['maxNodes', 'maxConcurrency', 'timeoutMs', 'maxTokens'] as const) {
        const value = policy[field];
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
            issues.push({ code: 'invalid-run-policy', message: `Flow runPolicy.${field} must be a positive integer` });
        }
    }
}

function validateConnectionReferences(flow: FlowRevision, issues: ValidationIssue[]): void {
    const slots = new Set((flow.connections ?? []).map(connection => connection.name));
    const value = flow.defaults?.connectionId;
    if (typeof value === 'string' && value && !slots.has(value)) {
        issues.push({ code: 'unknown-connection-slot', message: `Flow defaults references unknown connection slot: ${value}` });
    }
}

function validateNodes(
    definitions: FlowNodeDefinition[],
    plugins: DagPluginCatalog | undefined,
    issues: ValidationIssue[],
): Map<string, FlowNodeDefinition> {
    const nodes = new Map<string, FlowNodeDefinition>();
    for (const node of definitions) {
        if (nodes.has(node.id)) add(issues, 'duplicate-node', `Duplicate node ${node.id}`, node.id);
        nodes.set(node.id, node);
        const manifest = plugins?.getManifest(node.plugin, node.pluginVersion);
        if (plugins && !manifest) {
            add(issues, 'unknown-plugin', `Unknown plugin ${node.plugin}@${node.pluginVersion}`, node.id);
        }
        if (manifest) {
            for (const error of validateSchema(manifest.configSchema, node.config)) {
                add(issues, 'invalid-config', `${node.id}: ${error}`, node.id);
            }
        }
        validateDelegation(node, issues);
        validateSpawnPatch(node, issues);
        validateHarnessLimits(node, issues);
        try {
            if (node.plugin === 'builtin.join') validateWaitPolicy({ mode: 'all', ...node.config as object } as import('../contracts').FlowWaitPolicy);
            if (node.plugin === 'builtin.route' && node.pluginVersion === '2.0.0') validateDispatch(node.config as unknown as import('../contracts').DispatchConfig, true);
            if (node.plugin === 'builtin.input') validateFields((node.config as unknown as import('../contracts').FlowInputConfig).fields);
        } catch (error) { add(issues, 'invalid-structured-config', String(error), node.id); }
    }
    return nodes;
}

function validateHarnessLimits(node: FlowNodeDefinition, issues: ValidationIssue[]): void {
    if (node.retry && (!Number.isInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1
        || node.retry.maxAttempts > DELEGATION_LIMITS.retryAttempts)) {
        add(issues, 'invalid-retry', `${node.id}: retry.maxAttempts must be an integer between 1 and ${DELEGATION_LIMITS.retryAttempts}`, String(node.id));
    }
    for (const [dimension, limit] of Object.entries(node.budget ?? {})) {
        if (!Number.isFinite(limit) || limit < 0) add(issues, 'invalid-budget', `${node.id}: budget ${dimension} must be a non-negative number`, String(node.id));
    }
}

function validateDelegation(node: FlowNodeDefinition, issues: ValidationIssue[]): void {
    if (node.plugin !== 'builtin.agent' || !isRecord(node.config)) return;
    const delegation = isRecord(node.config.delegation) ? node.config.delegation : undefined;
    if (!delegation) return;
    if (delegation.enabled !== true) {
        if (Object.keys(delegation).some(key => key !== 'enabled')) {
            issues.push({ code: 'delegation-disabled', severity: 'warning', nodeId: String(node.id), message: `${node.id}: delegation is configured but not enabled` });
        }
        return;
    }
    if (typeof delegation.toolName === 'string' && delegation.toolName && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(delegation.toolName)) {
        add(issues, 'invalid-delegation-tool', `${node.id}: delegation tool name is invalid`, String(node.id));
    }
    const fanout = isRecord(delegation.fanout) ? delegation.fanout : {};
    const limits: Array<[string, unknown, number]> = [
        ['maxTasks', fanout.maxTasks, DELEGATION_LIMITS.maxTasks],
        ['maxConcurrency', fanout.maxConcurrency, DELEGATION_LIMITS.maxConcurrency],
        ['maxDepth', fanout.maxDepth, DELEGATION_LIMITS.maxDepth],
    ];
    for (const [name, value, upper] of limits) {
        if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > upper)) {
            add(issues, 'invalid-delegation-limit', `${node.id}: ${name} must be an integer between 1 and ${upper}`, String(node.id));
        }
    }
    if (typeof fanout.maxConcurrency === 'number' && typeof fanout.maxTasks === 'number' && fanout.maxConcurrency > fanout.maxTasks) {
        issues.push({ code: 'delegation-concurrency', severity: 'warning', nodeId: String(node.id), message: `${node.id}: maxConcurrency exceeds maxTasks` });
    }
    const execution = isRecord(delegation.execution) ? delegation.execution : {};
    const wait = isRecord(delegation.wait) ? delegation.wait : {};
    if (wait.quorum !== undefined && (!Number.isInteger(wait.quorum) || Number(wait.quorum) < 1)) {
        add(issues, 'invalid-delegation-quorum', `${node.id}: wait.quorum must be a positive integer`, String(node.id));
    }
    if (wait.mode === 'quorum' && typeof fanout.maxTasks === 'number' && typeof wait.quorum === 'number' && wait.quorum > fanout.maxTasks) {
        add(issues, 'invalid-delegation-quorum', `${node.id}: wait.quorum cannot exceed fanout.maxTasks`, String(node.id));
    }
    if (wait.timeoutMs !== undefined && (!Number.isInteger(wait.timeoutMs) || Number(wait.timeoutMs) < 1)) {
        add(issues, 'invalid-delegation-timeout', `${node.id}: wait.timeoutMs must be a positive integer`, String(node.id));
    }
    if (execution.mode === 'detached' && wait.timeoutMs === undefined) {
        add(issues, 'unbounded-detached-delegation', `${node.id}: detached delegation requires wait.timeoutMs so background work remains bounded`, String(node.id));
    }
    const failure = isRecord(delegation.failure) ? delegation.failure : {};
    if (failure.maxAttempts !== undefined && (!Number.isInteger(failure.maxAttempts)
        || Number(failure.maxAttempts) < 1 || Number(failure.maxAttempts) > DELEGATION_LIMITS.retryAttempts)) {
        add(issues, 'invalid-delegation-retry', `${node.id}: failure.maxAttempts must be an integer between 1 and ${DELEGATION_LIMITS.retryAttempts}`, String(node.id));
    }
    const budget = isRecord(delegation.budget) ? delegation.budget : {};
    for (const field of ['maxTokens', 'timeoutMs']) {
        const value = budget[field];
        if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) {
            add(issues, 'invalid-delegation-request-limit', `${node.id}: budget.${field} must be a positive integer`, String(node.id));
        }
    }
    if ('maxCostUsd' in budget) {
        issues.push({
            code: 'unsupported-delegation-cost', severity: 'warning', nodeId: String(node.id),
            message: `${node.id}: budget.maxCostUsd is no longer supported because no runtime cost meter is available`,
        });
    }
}

function validateSpawnPatch(node: FlowNodeDefinition, issues: ValidationIssue[]): void {
    if (node.plugin !== 'builtin.spawn' || !isRecord(node.config)) return;
    const spawn = isRecord(node.config.spawn) ? node.config.spawn : undefined;
    if (!spawn) return;
    const templates = Array.isArray(spawn.nodes) ? spawn.nodes.filter(isRecord) : [];
    const ids = new Set(templates.map(template => String(template.id ?? '')).filter(Boolean));
    const validEndpoint = (value: unknown): boolean => {
        const endpoint = String(value ?? '');
        return ids.has(endpoint) || endpoint === '$parent' || endpoint.startsWith('$upstream:');
    };
    if (ids.size !== templates.length) add(issues, 'invalid-spawn-nodes', `${node.id}: spawned node ids must be present and unique`, String(node.id));
    for (const edge of Array.isArray(spawn.edges) ? spawn.edges.filter(isRecord) : []) {
        if (!validEndpoint(edge.from) || !validEndpoint(edge.to)) {
            add(issues, 'invalid-spawn-edge', `${node.id}: spawned edge references an unknown template node`, String(node.id));
        }
    }
}

function validateEdges(
    edges: FlowEdgeDefinition[],
    nodes: Map<string, FlowNodeDefinition>,
    plugins: DagPluginCatalog | undefined,
    issues: ValidationIssue[],
): void {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const edge of edges) {
        if (ids.has(String(edge.id))) edgeIssue(issues, 'duplicate-edge-id', edge, 'Duplicate edge id');
        ids.add(String(edge.id));
        const key = [edge.from, edge.to, edge.kind, edge.output, edge.input].join('|');
        if (keys.has(key)) edgeIssue(issues, 'duplicate-edge', edge, 'Duplicate edge');
        keys.add(key);
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (!from || !to) edgeIssue(issues, 'unknown-edge-node', edge, 'Edge references an unknown node');
        else validatePorts(edge, from, to, plugins, issues);
        if (edge.from === edge.to) edgeIssue(issues, 'self-edge', edge, 'Self edges are forbidden');
    }
}

function validatePorts(
    edge: FlowEdgeDefinition,
    from: FlowNodeDefinition,
    to: FlowNodeDefinition,
    plugins: DagPluginCatalog | undefined,
    issues: ValidationIssue[],
): void {
    if (edge.kind !== 'data') return;
    if (!edge.output || !edge.input) {
        edgeIssue(issues, 'missing-port', edge, 'Data edge requires output and input');
        return;
    }
    const source = plugins?.getManifest(from.plugin, from.pluginVersion);
    const target = plugins?.getManifest(to.plugin, to.pluginVersion);
    const namedReturn = from.plugin === 'builtin.return' && isRecord(from.config) && isRecord(from.config.returns) && Object.hasOwn(from.config.returns, edge.output);
    const functionCall = from.plugin === 'builtin.flow' && from.pluginVersion === '2.0.0';
    if (source && !source.outputs.some(port => port.name === edge.output) && !functionCall && !namedReturn) {
        edgeIssue(issues, 'unknown-output', edge, `Unknown output ${edge.output}`);
    }
    if (target && !target.inputs.some(port => port.name === edge.input)) {
        edgeIssue(issues, 'unknown-input', edge, `Unknown input ${edge.input}`);
    }
    const schemaIssue = plugins && dataEdgeSchemaIssue(edge, from, to, plugins);
    if (schemaIssue) edgeIssue(issues, 'incompatible-port-schema', edge, schemaIssue);
}

function validateAcyclic(
    nodes: FlowNodeDefinition[],
    edges: FlowEdgeDefinition[],
    issues: ValidationIssue[],
): void {
    // Loops are a first-class runtime feature (DurableFlowExecutor re-enters
    // loop nodes up to maxIterations). A cycle is therefore only a warning;
    // callers gate publish/run on hasValidationErrors() below, not on warnings.
    if (findCycles(nodes, edges).backEdges.size > 0) {
        issues.push({
            code: 'loop',
            severity: 'warning',
            message: 'Flow contains a loop (iterates up to maxIterations)',
        });
    }
}

/** True when any issue must block publish/run (warnings never block). */
export function hasValidationErrors(issues: ValidationIssue[]): boolean {
    return issues.some(issue => issue.severity !== 'warning');
}

function validateConnections(
    connections: FlowConnection[] | undefined,
    defaultConnection: string | undefined,
    issues: ValidationIssue[],
): void {
    const seen = new Set<string>();
    for (const connection of connections ?? []) {
        if (!connection.name?.trim()) {
            issues.push({ code: 'invalid-connection', message: 'Connection slot requires a name' });
            continue;
        }
        if (seen.has(connection.name)) {
            issues.push({ code: 'duplicate-connection', message: `Duplicate connection slot: ${connection.name}` });
        }
        seen.add(connection.name);
        if (!connection.connectionId?.trim()) {
            issues.push({ code: 'invalid-connection', message: `Connection ${connection.name} requires a connectionId` });
        }
    }
    if (defaultConnection && !seen.has(defaultConnection)) {
        issues.push({ code: 'invalid-default-connection', message: `defaultConnection ${defaultConnection} is not a defined connection slot` });
    }
}

export function validateSchema(schema: JsonValue, value: JsonValue, path = '$'): string[] {
    if (!isRecord(schema)) return [];
    const errors: string[] = [];
    // A whole `${params.name}` placeholder is resolved at run time to the
    // parameter's native type, so skip static type checking for it here.
    if (typeof schema.type === 'string' && !isParameterTemplate(value) && !matchesType(schema.type, value)) {
        errors.push(`${path} must be ${schema.type}`);
    }
    if (Array.isArray(schema.required) && isRecord(value)) {
        for (const key of schema.required) {
            if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key} is required`);
        }
    }
    if (isRecord(schema.properties) && isRecord(value)) {
        for (const [key, child] of Object.entries(schema.properties)) {
            if (key in value) errors.push(...validateSchema(child, value[key], `${path}.${key}`));
        }
    }
    return errors;
}

function matchesType(type: string, value: JsonValue): boolean {
    if (type === 'object') return isRecord(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'null') return value === null;
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number';
    return typeof value === type;
}

/** True when the value is exactly one `${params.path}` template placeholder. */
function isParameterTemplate(value: JsonValue): boolean {
    return typeof value === 'string' && /^\$\{(?:params|param|nodes|state|iteration)\.([A-Za-z0-9_.-]+)\}$/.test(value.trim());
}

function canonicalJson(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function add(
    issues: ValidationIssue[],
    code: string,
    message: string,
    nodeId: string,
): void {
    issues.push({ code, message, nodeId });
}

function edgeIssue(
    issues: ValidationIssue[],
    code: string,
    edge: FlowEdgeDefinition,
    message: string,
): void {
    issues.push({ code, message: `${message}: ${edge.id}`, edgeId: String(edge.id) });
}

function deduplicate(issues: ValidationIssue[]): ValidationIssue[] {
    const seen = new Set<string>();
    return issues.filter(issue => {
        const key = `${issue.code}|${issue.nodeId}|${issue.edgeId}|${issue.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

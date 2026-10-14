import { flowTemplateReferences, renderFlowTemplate, type FlowTemplateContext } from '../contracts';
import type { DagNodeDefinition, DagRunSpec, FlowVariables, JsonValue } from '../contracts';
import { extractNodeOutput } from '@itookit/llm-tasks';

export interface VariableCommit { taskId: string; nodeId: string; scope: string; updates: Record<string, JsonValue> }
export interface VariableCheckpoint {
    initial: Record<string, Record<string, JsonValue>>;
    commits: VariableCommit[];
    snapshots: Record<string, FlowTemplateContext>;
}
export function variableScope(spec: DagRunSpec, id: string): string {
    return Object.keys(spec.variableScopes ?? {}).filter(prefix => id.startsWith(prefix)).sort((a, b) => b.length - a.length)[0] ?? '';
}
export function variableDefinitions(spec: DagRunSpec, id: string): FlowVariables {
    const scope = variableScope(spec, id);
    return scope ? spec.variableScopes![scope] : spec.variables ?? {};
}
export function assertVariableValue(name: string, value: unknown, definitions: FlowVariables): asserts value is JsonValue {
    const declaration = definitions[name];
    if (!declaration || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error(`Undeclared Flow variable: ${name}`);
    if (value === undefined || (declaration.type !== 'json' && typeof value !== declaration.type)
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Invalid Flow variable value: ${name} (${declaration.type})`);
}
export function initializeVariables(definitions: FlowVariables, context: FlowTemplateContext): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(definitions).map(([name, declaration]) => {
        const value = renderFlowTemplate(declaration.initial, context);
        assertVariableValue(name, value, definitions);
        return [name, value];
    }));
}
export function assignmentUpdates(assign: Record<string, JsonValue> | undefined, output: unknown, context: FlowTemplateContext, definitions: FlowVariables): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(assign ?? {}).map(([name, expression]) => {
        const value = renderFlowTemplate(expression, { ...context, output });
        assertVariableValue(name, value, definitions);
        return [name, value];
    }));
}

/** Checkpointed writes are keyed by task identity; retry removes superseded tasks. */
export class FlowVariableStore {
    readonly state: VariableCheckpoint;
    constructor(private spec: DagRunSpec, saved?: VariableCheckpoint) {
        this.state = structuredClone(saved ?? { initial: {}, commits: [], snapshots: {} });
    }
    retry(sourceTaskId: string, retryTaskId: string): void {
        this.state.commits = this.state.commits.filter(entry => entry.taskId !== sourceTaskId);
        this.state.snapshots[retryTaskId] ??= structuredClone(this.state.snapshots[sourceTaskId] ?? {});
    }
    prune(active: Set<string>): void { this.state.commits = this.state.commits.filter(entry => active.has(entry.taskId)); }
    snapshot(node: DagNodeDefinition, context: FlowTemplateContext): FlowTemplateContext {
        const definitions = variableDefinitions(this.spec, node.id), scope = variableScope(this.spec, node.id);
        const uses = nodeUsesVariables(node, definitions);
        if (!uses) return context;
        this.state.initial[scope] ??= initializeVariables(definitions, context);
        const vars = { ...this.state.initial[scope] };
        for (const entry of this.state.commits) if (entry.scope === scope) Object.assign(vars, entry.updates);
        return { ...context, vars: structuredClone(vars) };
    }
    remember(taskId: string, context: FlowTemplateContext): void { this.state.snapshots[taskId] = structuredClone(context); }
    commit(node: DagNodeDefinition, taskId: string, output: unknown): void {
        if (this.state.commits.some(entry => entry.taskId === taskId)) return;
        const definitions = variableDefinitions(this.spec, node.id), context = this.state.snapshots[taskId] ?? {};
        const raw = extractNodeOutput(output, 'result');
        const value = node.plugin === 'builtin.agent' && typeof raw === 'string' && flowTemplateReferences(node.assign).some(ref => ref.root === 'output' && ref.path.length)
            ? JSON.parse(raw) : raw;
        const updates = assignmentUpdates(node.assign, value, context, definitions);
        if (node.plugin === 'builtin.route' && node.pluginVersion === '2.0.0' && value && typeof value === 'object' && 'vars' in value) {
            for (const [name, item] of Object.entries(value.vars as Record<string, unknown>).filter(([key]) => nodeAccess(node, definitions).write.has(key))) {
                assertVariableValue(name, item, definitions); updates[name] = item;
            }
        }
        if (Object.keys(updates).length) this.state.commits.push({ nodeId: node.id, taskId, scope: variableScope(this.spec, node.id), updates });
    }
}

/** Shared variables require explicit ordering; disjoint parallel writes remain legal. */
export function validateVariableGraph(spec: DagRunSpec): void {
    for (const definitions of [spec.variables ?? {}, ...Object.values(spec.variableScopes ?? {})]) validateDeclarations(definitions);
    const access = spec.nodes.map(node => nodeAccess(node, variableDefinitions(spec, node.id)));
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
        if (from === to) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return spec.edges.some(edge => edge.from === from && reaches(edge.to, to, seen));
    };
    for (let i = 0; i < access.length; i++) for (let j = i + 1; j < access.length; j++) {
        const a = access[i], b = access[j];
        if (variableScope(spec, a.id) !== variableScope(spec, b.id)) continue;
        const conflict = [...a.write].some(key => b.read.has(key) || b.write.has(key)) || [...b.write].some(key => a.read.has(key));
        if (conflict && !reaches(a.id, b.id) && !reaches(b.id, a.id)) throw new Error(`Unordered Flow variable access: ${a.id}, ${b.id}; add an explicit dependency`);
    }
}
function validateDeclarations(definitions: FlowVariables): void {
    for (const [key, value] of Object.entries(definitions)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Invalid Flow variable name: ${key}`);
        if (!value || !['string', 'number', 'boolean', 'json'].includes(value.type) || !Object.hasOwn(value, 'initial')) throw new Error(`Invalid Flow variable declaration: ${key}`);
        if (flowTemplateReferences(value.initial).some(ref => ref.root !== 'param')) throw new Error(`Variable initial values may reference only param: ${key}`);
        if (!flowTemplateReferences(value.initial).length) assertVariableValue(key, value.initial, definitions);
    }
}
function nodeAccess(node: DagNodeDefinition, definitions: FlowVariables) {
    assertAssignments(node.assign);
    const refs = flowTemplateReferences([node.config, node.inputs, node.assign]);
    const read = new Set(refs.filter(ref => ref.root === 'vars').map(ref => ref.path[0]));
    const write = new Set(Object.keys(node.assign ?? {}));
    const config = node.config as import('../contracts').DispatchConfig;
    if (node.plugin === 'builtin.route' && node.pluginVersion === '2.0.0') {
        const batchWrites = new Set<string>();
        for (const branch of config.branches) for (const key of Object.keys(branch.assign ?? {})) {
            if (config.mode === 'multicast' && batchWrites.has(key)) throw new Error(`Concurrent variable assignment: ${key}`);
            batchWrites.add(key);
        }
        for (const branch of [...config.branches, ...(config.revision?.invocation ? [config.revision.invocation] : [])]) {
            assertAssignments(branch.assign);
            for (const key of Object.keys(branch.assign ?? {})) write.add(key);
        }
    }
    for (const key of [...read, ...write]) if (!Object.hasOwn(definitions, key)) throw new Error(`Undeclared Flow variable: ${node.id}.${key}`);
    return { id: node.id, read, write };
}

function assertAssignments(value: unknown): void {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Flow assign must be an object');
}

export function variableCurrent(state: VariableCheckpoint): Record<string, Record<string, JsonValue>> {
    const current = structuredClone(state.initial);
    for (const entry of state.commits) Object.assign(current[entry.scope] ??= {}, entry.updates);
    return current;
}

export function nodeUsesVariables(node: DagNodeDefinition, definitions: FlowVariables): boolean {
    const access = nodeAccess(node, definitions);
    return access.read.size > 0 || access.write.size > 0;
}

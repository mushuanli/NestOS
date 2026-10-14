import { remapFlowNodeReferences } from '../contracts';
import type { DagRunSpec, FlowRevision, FlowNodeDefinition } from '../contracts';
import { resolveNodeConnection } from './connections';
import { resolveFlowParameters, flowParameterValues } from './parameters';
import { compileReferenceGraph } from './structured/references';
import { compileDispatchGraph } from './structured/graph';
import { compileControlGraph } from './control/graph';
import { withFlowReturns, RETURN_NODE } from './function-outputs';
import { callEntry, assertCallable } from './function-call';
import { namespaceCallConfig, remapRouteEdges } from './function-namespace';

export type FlowNodeBinder = (
    node: FlowNodeDefinition,
    flowDefaults?: FlowNodeDefinition['config'],
) =>
    | Partial<Pick<FlowNodeDefinition, 'config' | 'inputs' | 'capabilities' | 'budget'>>
    | Promise<Partial<Pick<FlowNodeDefinition, 'config' | 'inputs' | 'capabilities' | 'budget'>>>;

export async function flowToDag(
    flow: FlowRevision,
    bind?: FlowNodeBinder,
    fallbackConnectionId?: string,
    resolveComposite?: (id: string, revision?: number) => Promise<FlowRevision | null>,
    compositeStack: string[] = [],
    dependencyLocks = flow.dependencyLocks,
    isolated = false,
    runConnectionId?: string,
): Promise<DagRunSpec> {
    if (compositeStack.length > 32) throw new Error('Flow nesting exceeds 32 calls');
    if (runConnectionId) flow = { ...flow, defaults: { ...(isRecord(flow.defaults) ? flow.defaults : {}),
        connectionId: undefined, modelName: undefined } as FlowRevision['defaults'] };
    flow = compileReferenceGraph(withFlowReturns(compileControlGraph(compileDispatchGraph(flow))));
    const nodes = await Promise.all(flow.nodes.map(async node => {
        if (node.plugin === 'builtin.flow' && node.pluginVersion === '2.0.0') return {
            ...structuredClone(node), id: String(node.id), compensate: node.compensate ? String(node.compensate) : undefined,
            config: structuredClone(node.config), inputs: structuredClone(node.inputs), capabilities: node.capabilities ?? [], budget: node.budget ?? {},
        };
        const defaults = node.plugin === 'builtin.agent' ? flowAgentDefaults(flow) : undefined;
        if (isolated) node = { ...node, config: { ...(defaults ? mergeAgentConfig(defaults, node.config) : isRecord(node.config) ? node.config : {}), invocationContext: 'isolated' } as FlowNodeDefinition['config'] };
        const patch = (await bind?.(node, defaults as FlowNodeDefinition['config'])) ?? {};
        const config = cloneJson((patch.config ?? (defaults && !isolated ? mergeAgentConfig(defaults, node.config) : node.config)) as FlowNodeDefinition['config']);
        resolveNodeConnection(config, flow.connections, flow.defaultConnection, fallbackConnectionId, runConnectionId);
        return {
            assign: structuredClone(node.assign),
            id: String(node.id),
            name: node.name,
            plugin: node.plugin,
            pluginVersion: node.pluginVersion,
            outputPolicy: node.outputPolicy ? structuredClone(node.outputPolicy) : undefined,
            portSchemas: node.portSchemas ? structuredClone(node.portSchemas) : undefined,
            config,
            inputs: cloneJson(patch.inputs ?? node.inputs),
            priority: node.priority,
            retry: node.retry,
            compensate: node.compensate ? String(node.compensate) : undefined,
            capabilities: [...(patch.capabilities ?? node.capabilities ?? [])],
            budget: {
                ...(node.budget ?? {}),
                ...(patch.budget ?? {}),
            },
        };
    }));
    const base: DagRunSpec = {
        variables: structuredClone(flow.variables),
        templateVersion: 1,
        parameterSchema: structuredClone(flow.parameters),
        nodes,
        nodeDefaults: Object.fromEntries(nodes.map(node => [node.id, cloneJson(flowAgentDefaults(flow))])),
        nodeConnections: Object.fromEntries(nodes.map(node => [node.id, cloneJson({
            connections: flow.connections, defaultConnection: flow.defaultConnection, fallbackConnectionId, runConnectionId,
        })])),
        edges: flow.edges.map(edge => ({
            id: String(edge.id),
            from: String(edge.from),
            to: String(edge.to),
            output: edge.output ?? 'result',
            input: edge.input ?? 'input',
            kind: edge.kind,
            onFailure: edge.onFailure,
        })),
        ...(flow.runPolicy ? {
            runPolicy: cloneJson(flow.runPolicy),
            maxNodes: flow.runPolicy.maxNodes,
            maxConcurrency: flow.runPolicy.maxConcurrency,
            timeoutMs: flow.runPolicy.timeoutMs,
            maxTokens: flow.runPolicy.maxTokens,
        } : {}),
    };
    return expandCompositeNodes(base, bind, fallbackConnectionId, resolveComposite, compositeStack, dependencyLocks, isolated, runConnectionId);
}

async function expandCompositeNodes(
    spec: DagRunSpec,
    bind: FlowNodeBinder | undefined,
    fallbackConnectionId: string | undefined,
    resolveComposite: ((id: string, revision?: number) => Promise<FlowRevision | null>) | undefined,
    compositeStack: string[],
    dependencyLocks: FlowRevision['dependencyLocks'],
    isolated: boolean,
    runConnectionId?: string,
): Promise<DagRunSpec> {
    const composites = spec.nodes.filter(node => node.plugin === 'builtin.flow');
    if (!composites.length) return spec;
    if (!resolveComposite) throw new Error('Composite Flow nodes require a Flow revision resolver');
    const parameterScopes = { ...spec.parameterScopes };
    const variableScopes = { ...spec.variableScopes };
    const nodeDefaults = { ...spec.nodeDefaults };
    const nodeConnections = { ...spec.nodeConnections };
    const replacement = new Map<string, { entries: string[]; exits: string[] }>();
    const expandedNodes = spec.nodes.filter(node => node.plugin !== 'builtin.flow');
    const expandedEdges = spec.edges.filter(edge =>
        !composites.some(node => node.id === edge.from || node.id === edge.to));
    for (const composite of composites) {
        const config = isRecord(composite.config) ? composite.config : {};
        const flowId = typeof config.flowId === 'string' ? config.flowId : '';
        if (!flowId) throw new Error(`Composite node ${composite.id} requires flowId`);
        const lock = dependencyLocks?.[composite.id];
        if (dependencyLocks && (!lock || lock.flowId !== flowId)) throw new Error(`Missing Flow dependency lock: ${composite.id}`);
        const revision = lock?.revision ?? (typeof config.revision === 'number' ? config.revision : undefined);
        const reference = `${flowId}@${revision ?? 'latest'}`;
        if (compositeStack.includes(reference)) {
            throw new Error(`Composite Flow cycle: ${[...compositeStack, reference].join(' -> ')}`);
        }
        const flow = await resolveComposite(flowId, revision);
        if (!flow) throw new Error(`Composite Flow not found: ${flowId}${revision ? `@${revision}` : ''}`);
        if (lock && lock.digest !== flow.digest) throw new Error(`Flow dependency digest mismatch: ${flowId}`);
        if (config.digest && config.digest !== flow.digest) throw new Error(`Flow dependency digest mismatch: ${flowId}`);
        const callable = composite.pluginVersion === '2.0.0';
        if (callable && spec.nodes.some(node => node.plugin === 'builtin.taskGroup' && isRecord(node.config)
            && Array.isArray(node.config.members) && node.config.members.includes(composite.id))) {
            throw new Error(`Flow call ${composite.id}: taskGroup cannot limit a whole function; configure concurrency on the parent Run`);
        }
        const child = await flowToDag(flow, bind, fallbackConnectionId, resolveComposite, [...compositeStack, reference], lock?.children ?? flow.dependencyLocks, callable || isolated, runConnectionId);
        const entry = callable ? callEntry(composite) : undefined;
        if (entry && spec.nodes.some(node => node.id === entry.id || node.id.startsWith(`${composite.id}/`))) throw new Error(`Flow call namespace collision: ${composite.id}`);
        if (callable) assertCallable(flow, child);
        if (entry) expandedNodes.push(entry);
        if (!child.nodes.length) throw new Error(`Composite Flow is empty: ${flowId}`);
        const prefix = `${composite.id}/`;
        variableScopes[prefix] = child.variables ?? {};
        for (const [scope, variables] of Object.entries(child.variableScopes ?? {})) variableScopes[`${prefix}${scope}`] = variables;
        delete nodeDefaults[composite.id];
        delete nodeConnections[composite.id];
        for (const [id, scope] of Object.entries(child.nodeConnections ?? {})) nodeConnections[`${prefix}${id}`] = scope;
        for (const [id, defaults] of Object.entries(child.nodeDefaults ?? {})) {
            nodeDefaults[`${prefix}${id}`] = parametersForDefaults(defaults, config.parameters);
        }
        const childIds = new Set(child.nodes.map(node => node.id));
        const incoming = new Set(child.edges.map(edge => edge.to));
        const outgoing = new Set(child.edges.map(edge => edge.from));
        const entries = child.nodes.filter(node => !incoming.has(node.id)).map(node => `${prefix}${node.id}`);
        const exits = child.nodes.filter(node => !outgoing.has(node.id)).map(node => `${prefix}${node.id}`);
        const parameters = isRecord(config.parameters) ? config.parameters as Record<string, import('../contracts').JsonValue> : {};
        parameterScopes[prefix] = { parent: composite.id.slice(0, composite.id.lastIndexOf('/') + 1), defaults: flowParameterValues(child.parameterSchema), values: parameters, schema: child.parameterSchema };
        if (entry) parameterScopes[prefix].source = entry.id;
        for (const [id, scope] of Object.entries(child.parameterScopes ?? {})) parameterScopes[`${prefix}${id}`] = { ...scope, parent: `${prefix}${scope.parent}`, ...(scope.source ? { source: `${prefix}${scope.source}` } : {}) };
        for (const node of child.nodes) {
            expandedNodes.push({
                ...node,
                id: `${prefix}${node.id}`,
                name: `${composite.name} / ${node.name}`,
                assign: remapFlowNodeReferences(node.assign, Object.fromEntries(child.nodes.map(item => [item.id, `${prefix}${item.id}`]))) as typeof node.assign,
                config: namespaceCallConfig(node, child, prefix),
                inputs: {
                    ...remapFlowNodeReferences(node.inputs, Object.fromEntries(child.nodes.map(item => [item.id, `${prefix}${item.id}`]))) as Record<string, unknown>,
                    ...(entries.includes(`${prefix}${node.id}`) ? composite.inputs : {}),
                },
                ...(node.compensate && childIds.has(node.compensate) ? { compensate: `${prefix}${node.compensate}` } : {}),
            });
        }
        expandedEdges.push(...child.edges.map(edge => ({
            ...edge, id: `${prefix}${edge.id}`, from: `${prefix}${edge.from}`, to: `${prefix}${edge.to}`,
        })));
        if (entry) for (const node of child.nodes) expandedEdges.push({ id: `${entry.id}:${prefix}${node.id}`, from: entry.id, to: `${prefix}${node.id}`, kind: 'control', input: 'input', output: 'result' });
        replacement.set(composite.id, { entries: entry ? [entry.id] : entries, exits: callable ? [`${prefix}${RETURN_NODE}`] : exits });
        if (expandedNodes.length > (spec.maxNodes ?? 1000)) throw new Error('Expanded Flow exceeds node limit');
    }
    const edgeAliases: Record<string, string> = {};
    for (const edge of spec.edges) {
        const sources = replacement.get(edge.from)?.exits ?? [edge.from];
        const targets = replacement.get(edge.to)?.entries ?? [edge.to];
        if (!replacement.has(edge.from) && !replacement.has(edge.to)) continue;
        for (const source of sources) for (const target of targets) {
            const id = `${edge.id}:${source}->${target}`;
            expandedEdges.push({ ...edge, id, from: source, to: target });
            if (sources.length === 1 && targets.length === 1) edgeAliases[edge.id] = id;
        }
    }
    const aliases = Object.fromEntries([...replacement].filter(([, value]) => value.exits.length === 1).map(([id, value]) => [id, value.exits[0]]));
    const mappedNodes = expandedNodes.map(node => ({ ...node, assign: remapFlowNodeReferences(node.assign, aliases) as typeof node.assign, config: remapRouteEdges(node, remapFlowNodeReferences(node.config, aliases), edgeAliases), inputs: remapFlowNodeReferences(node.inputs, aliases) as typeof node.inputs }));
    return { ...spec, variableScopes, parameterScopes, nodeDefaults, nodeConnections, nodes: mappedNodes, edges: expandedEdges };
}

/** Apply Flow defaults before the session/agent binder applies its higher layers. */
function flowAgentDefaults(flow: FlowRevision): Record<string, unknown> {
    const defaults = isRecord(flow.defaults) ? { ...flow.defaults } : {};
    return {
        ...defaults,
        systemPrompt: [
            ...(Array.isArray(flow.systemPrompt) ? flow.systemPrompt : []),
            ...(Array.isArray(defaults.systemPrompt) ? defaults.systemPrompt : []),
        ],
        toolIds: [...new Set([
            ...(Array.isArray(flow.toolIds) ? flow.toolIds : []),
            ...(Array.isArray(defaults.toolIds) ? defaults.toolIds : []),
        ].map(String))],
    };
}

export function mergeAgentConfig(defaultsValue: Record<string, unknown>, nodeConfig: FlowNodeDefinition['config']): Record<string, unknown> {
    const defaults = defaultsValue;
    const node = isRecord(nodeConfig) ? nodeConfig : {};
    const defaultPrompt = Array.isArray(defaults.systemPrompt) ? defaults.systemPrompt : [];
    const nodePrompt = Array.isArray(node.systemPrompt) ? node.systemPrompt : [];
    const defaultTools = Array.isArray(defaults.toolIds) ? defaults.toolIds : [];
    const nodeTools = Array.isArray(node.toolIds) ? node.toolIds : [];
    return {
        ...defaults,
        ...node,
        systemPrompt: (node.systemPromptPolicy ?? defaults.systemPromptPolicy) === 'none' ? []
            : (node.systemPromptPolicy ?? defaults.systemPromptPolicy) === 'replace' ? nodePrompt : [...defaultPrompt, ...nodePrompt],
        toolIds: [...new Set([...defaultTools, ...nodeTools].map(String))],
        skillIds: [...new Set([
            ...(Array.isArray(defaults.skillIds) ? defaults.skillIds : []),
            ...(Array.isArray(node.skillIds) ? node.skillIds : []),
        ].map(String))],
    };
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parametersForDefaults(defaults: Record<string, unknown>, parameters: unknown): Record<string, unknown> {
    return isRecord(parameters) ? resolveFlowParameters(defaults, parameters as Record<string, import('../contracts').JsonValue>) as Record<string, unknown> : defaults;
}

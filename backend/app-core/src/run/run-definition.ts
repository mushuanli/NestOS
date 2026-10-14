import type { DagEdgeDefinition, DagNodeDefinition, FlowParameter, FlowRevision, FlowRunPolicy, JsonValue } from '@itookit/llm-flow/contracts';
import { flowToDag, type FlowNodeBinder } from '@itookit/llm-flow';

export type RunSourceFormat = 'yaml' | 'flow';
export type RunStatus = 'created' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface RunModelConfig {
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    supportsTools?: boolean;
    supportsThinking?: boolean;
}

export interface RunProviderConfig {
    id: string;
    name?: string;
    implementation: 'openai-compatible' | 'anthropic' | 'gemini' | 'custom';
    baseUrl: string;
    defaultPath?: string;
    responsesPath?: string;
    /** Host resolves this environment variable; secrets never enter RunDefinition snapshots. */
    apiKeyEnv?: string;
    models: RunModelConfig[];
}

export interface RunConnectionConfig {
    id: string;
    name?: string;
    provider: string;
    protocol?: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate';
    tiers: Partial<Record<'optimal' | 'standard' | 'fast', string>>;
}

export interface RunAgentConfig {
    memoryPolicy?: import('@itookit/llm-tasks/contracts').MemoryPolicy;
    id: string;
    name?: string;
    connection: string;
    modelTier?: 'optimal' | 'standard' | 'fast';
    model?: string;
    systemPrompt?: string;
    tools?: string[];
    maxExchanges?: number;
    temperature?: number;
    maxTokens?: number;
    thinking?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'xhigh';
    stream?: boolean;
    webSearch?: boolean;
    approval?: 'none' | 'external' | 'all';
}

export interface RunSandboxConfig {
    mode?: 'native' | 'oci';
    engine?: 'auto' | 'podman' | 'docker';
    image?: string;
    network?: 'none' | 'host';
    limits?: { cpus?: number; memory?: string; pids?: number };
}

export interface RunEnvironment {
    providers?: RunProviderConfig[];
    connections?: RunConnectionConfig[];
    agents?: RunAgentConfig[];
    sandbox?: RunSandboxConfig;
}

export interface RunPolicy {
    runPolicy?: FlowRunPolicy;
    result?: { task: string; output: string };
    /** Host directory mounted at /workspace and used as the Session cwd. */
    workspaceRoot?: string;
    /** Additional host directories mounted read-only unless marked rw. */
    additionalDirectories?: Array<{ path: string; access: 'ro' | 'rw'; at?: string }>;
}

/**
 * Canonical runtime definition produced by both YAML and .flow inputs.
 * DagRunSpec remains the executor-facing compiled form.
 */
export interface RunDefinition {
    id: string;
    name: string;
    revision: number;
    digest: string;
    source: RunSourceFormat;
    graph: {
        nodes: DagNodeDefinition[];
        edges: DagEdgeDefinition[];
        nodeDefaults?: Record<string, Record<string, JsonValue>>;
        nodeConnections?: Record<string, Record<string, JsonValue>>;
        maxNodes?: number;
        templateVersion?: import('@itookit/llm-flow/contracts').DagRunSpec['templateVersion'];
        parameterScopes?: import('@itookit/llm-flow/contracts').DagRunSpec['parameterScopes'];
    };
    parameters?: FlowParameter[];
    environment: RunEnvironment;
    policy: RunPolicy;
    /** Source-specific metadata kept for display and diagnostics; never used for scheduling. */
    metadata?: Record<string, JsonValue>;
    createdAt: number;
}

export interface RunRecord {
    id: string;
    sessionId: string;
    definitionId: string;
    definitionRevision: number;
    definitionDigest: string;
    status: RunStatus;
    rootTaskId?: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    error?: string;
    resultPath?: string;
}


/** Build the canonical RunDefinition from a stored FlowRevision. */
export async function createRunDefinitionFromFlow(flow: FlowRevision, options: {
    workspaceRoot?: string;
    result?: { task: string; output: string };
    fallbackConnectionId?: string;
    bind?: FlowNodeBinder;
    resolveComposite?: (id: string, revision?: number) => Promise<FlowRevision | null>;
} = {}): Promise<RunDefinition> {
    const dag = await flowToDag(flow, options.bind, options.fallbackConnectionId, options.resolveComposite);
    return {
        id: String(flow.id),
        name: flow.name,
        revision: flow.revision,
        digest: flow.digest,
        source: 'flow',
        graph: {
            nodes: structuredClone(dag.nodes) as DagNodeDefinition[],
            edges: structuredClone(dag.edges) as DagEdgeDefinition[],
            templateVersion: dag.templateVersion,
            parameterScopes: structuredClone(dag.parameterScopes),
            ...(dag.nodeDefaults ? { nodeDefaults: structuredClone(dag.nodeDefaults) as Record<string, Record<string, JsonValue>> } : {}),
            ...(dag.nodeConnections ? { nodeConnections: structuredClone(dag.nodeConnections) as Record<string, Record<string, JsonValue>> } : {}),
            ...(dag.maxNodes !== undefined ? { maxNodes: dag.maxNodes } : {}),
        },
        parameters: flow.parameters ? structuredClone(flow.parameters) : [],
        environment: {
            connections: (flow.connections ?? []).map(connection => ({
                id: connection.name,
                name: connection.description ?? connection.name,
                provider: connection.connectionId,
                tiers: {},
            })),
            agents: [],
            providers: [],
        },
        policy: {
            runPolicy: flow.runPolicy ? structuredClone(flow.runPolicy) : undefined,
            ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
            ...(options.result ? { result: options.result } : {}),
        },
        metadata: {
            flowId: String(flow.id),
            ...(flow.systemPrompt ? { systemPrompt: flow.systemPrompt } : {}),
            ...(flow.toolIds ? { toolIds: flow.toolIds } : {}),
        },
        createdAt: flow.createdAt,
    };
}


/** Compile the canonical RunDefinition into the executor-facing DagRunSpec. */
export function toDagRunSpec(definition: RunDefinition): import('@itookit/llm-flow/contracts').DagRunSpec {
    const policy = definition.policy.runPolicy;
    return {
        nodes: structuredClone(definition.graph.nodes),
        edges: structuredClone(definition.graph.edges),
        templateVersion: definition.graph.templateVersion,
        parameterScopes: structuredClone(definition.graph.parameterScopes),
        parameterSchema: structuredClone(definition.parameters),
        ...(definition.graph.nodeDefaults ? { nodeDefaults: structuredClone(definition.graph.nodeDefaults) } : {}),
        ...(definition.graph.nodeConnections ? { nodeConnections: structuredClone(definition.graph.nodeConnections) } : {}),
        ...(definition.graph.maxNodes !== undefined ? { maxNodes: definition.graph.maxNodes } : {}),
        ...(policy?.maxConcurrency !== undefined ? { maxConcurrency: policy.maxConcurrency } : {}),
        ...(policy?.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
        ...(policy?.maxTokens !== undefined ? { maxTokens: policy.maxTokens } : {}),
        ...(policy ? { runPolicy: structuredClone(policy) } : {}),
    };
}

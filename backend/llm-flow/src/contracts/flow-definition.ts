import type { FlowNodeId } from './flow';
import type { LlmNodeConfig } from '@itookit/llm-tasks/contracts';

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type FlowId = Brand<string, 'FlowId'>;
export type FlowEdgeId = Brand<string, 'FlowEdgeId'>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
    | JsonPrimitive
    | JsonValue[]
    | { [key: string]: JsonValue };

export interface JsonSchemaRef {
    id: string;
    version?: string;
}

export interface InputPortSpec {
    name: string;
    schema?: JsonSchemaRef;
    cardinality: 'one' | 'many';
    required: boolean;
    order: number;
}

export interface OutputPortSpec {
    name: string;
    schema?: JsonSchemaRef;
    required: boolean;
    order: number;
}

export interface SerializableExpression {
    kind: 'literal' | 'path' | 'param' | 'not' | 'and' | 'or' | 'eq' | 'neq' | 'in' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte';
    value?: JsonValue;
    path?: string[];
    args?: SerializableExpression[];
}

export interface FlowEdgeDefinition {
    id: FlowEdgeId;
    from: FlowNodeId;
    to: FlowNodeId;
    kind: 'control' | 'data';
    order?: number;
    output?: string;
    input?: string;
    onFailure?: 'fail' | 'skip' | 'continue';
}

/** Run-local schema definitions are immutable per id/version and may be referenced by other nodes. */
export interface NodePortSchema extends JsonSchemaRef { definition?: JsonValue; }
export interface NodePortSchemas {
    inputs?: Record<string, NodePortSchema>;
    outputs?: Record<string, NodePortSchema>;
}

export interface FlowVariable {
    type: 'string' | 'number' | 'boolean' | 'json';
    initial: JsonValue;
}
export type FlowVariables = Record<string, FlowVariable>;

export interface FlowNodeDefinition {
    assign?: Record<string, JsonValue>;
    /** Result projection never disables durable Task output or downstream data access. */
    outputPolicy?: { includeInRunOutput?: boolean; publishToHistory?: boolean };
    portSchemas?: NodePortSchemas;
    id: FlowNodeId;
    name: string;
    plugin: string;
    pluginVersion: string;
    config: JsonValue;
    inputs: Record<string, JsonValue>;
    priority?: number;
    capabilities?: string[];
    budget?: Record<string, number>;
    retry?: { maxAttempts: number; backoffMs?: number };
    /** Saga compensation node invoked when this node fails. */
    compensate?: FlowNodeId;
}

export interface FlowLayout {
    nodes?: Record<string, { x: number; y: number }>;
    viewport?: { x: number; y: number; zoom: number };
}

export interface FlowDraft {
    outputs?: Record<string, { value: JsonValue; schema?: JsonValue }>;
    id: FlowId;
    draftVersion: number;
    baseRevision?: number;
    name: string;
    nodes: FlowNodeDefinition[];
    edges: FlowEdgeDefinition[];
    layout: FlowLayout;
    /** Declared runtime parameters (editable in the designer, frozen into revisions). */
    parameters?: FlowParameter[];
    variables?: FlowVariables;
    /** Named connection slots; nodes reference a slot by name (default = defaultConnection). */
    connections?: FlowConnection[];
    /** Connection slot name used when a node does not specify one. */
    defaultConnection?: string;
    /** Flow-level system prompt segments (default base for nodes without agentId). */
    systemPrompt?: string[];
    /** Flow-level tool ids (union with node toolIds). */
    toolIds?: string[];
    /** Defaults inherited by builtin.agent nodes before agent/node overrides. */
    defaults?: FlowDefaults;
    /** Runtime safety, concurrency and workspace defaults. */
    runPolicy?: FlowRunPolicy;
    updatedAt: number;
}

/**
 * A runtime parameter a workflow declares in its "signature". Node config/inputs
 * reference it via the `${params.<name>}` template; each run supplies a value.
 */
export interface FlowParameter {
    widget?: 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
    label?: string;
    nonBlank?: boolean;
    options?: JsonValue[];
    name: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required?: boolean;
    minimum?: number;
    maximum?: number;
    integer?: boolean;
    /** Missing values may be collected by an explicit builtin.input node. */
    onMissing?: 'error' | 'interact';
    default?: JsonValue;
    description?: string;
}

/**
 * A named connection slot a workflow defines (e.g. `default`, `economy`,
 * `premium`). Each slot binds a global LLMConnection.id; nodes reference the
 * slot by `name` in their `config.connectionId`. The workflow-level
 * `defaultConnection` is used when a node does not name one.
 */
export interface FlowConnection {
    name: string;
    connectionId: string;
    description?: string;
}

/** Legacy sub-task fan-out declaration. Prefer DelegationConfig. */
export interface SubtaskDecl {
    tool: string;
    template: FlowNodeDefinition;
    max?: number;
}

export type DelegationContextSource = 'session' | 'parent' | 'upstream' | 'isolated';

/** Structured dynamic delegation for an LLM Agent node. */
export interface DelegationConfig {
    enabled: boolean;
    /** Defaults to DELEGATION_DEFAULTS.toolName. */
    toolName?: string;
    toolDescription?: string;
    template?: Partial<LlmNodeConfig> & {
        agentId?: string;
        /** Canonical child task instruction. */
        instruction?: string;
        /** @deprecated Use instruction. */
        prompt?: string;
        contextSource?: DelegationContextSource;
        includeParentSystemPrompt?: boolean;
        includeToolResults?: boolean;
    };
    fanout?: {
        maxTasks?: number;
        maxConcurrency?: number;
        maxDepth?: number;
        order?: 'parallel' | 'sequential';
    };
    join?: { mode?: 'all' | 'none' };
    /** Structured child lifetime. Defaults to structured. */
    execution?: { mode?: 'structured' | 'detached' };
    /** Dynamic wait semantics. Static all-of dependencies remain DAG edges. */
    wait?: {
        mode?: 'all' | 'any' | 'first-success' | 'quorum';
        quorum?: number;
        timeoutMs?: number;
        /** Explicit sibling policy after an early wait is satisfied. Legacy default: cancel. */
        remaining?: 'continue' | 'cancel';
    };
    /** Whether and in which order child results enter the Flow aggregate. */
    result?: {
        mode?: 'collect' | 'discard';
        order?: 'declared' | 'completion';
    };
    failure?: {
        policy?: 'fail-fast' | 'continue' | 'retry';
        maxAttempts?: number;
        backoffMs?: number;
    };
    budget?: {
        /** Per LLM request output-token limit, not a cumulative token budget. */
        maxTokens?: number;
        /** Per LLM request timeout. */
        timeoutMs?: number;
    };
}

/**
 * Config of a `builtin.agent` node: a unified LlmNodeConfig (references to
 * system prompt / tools / skills / connection + inline additions) plus a
 * `agentId` shortcut that inherits one Agent's whole reference set at once.
 */
export interface FlowAgentNodeConfig extends Partial<LlmNodeConfig> {
    agentId?: string;
    /** Canonical task instruction, appended as the final system segment. */
    instruction?: string;
    /** @deprecated Use instruction. */
    prompt?: string;
    /** @deprecated Use modelName. */
    model?: string;
    delegation?: DelegationConfig;
    /** @deprecated Backward-compatible alias for delegation. */
    subtasks?: SubtaskDecl;
}

/** Flow-wide defaults for builtin.agent nodes. Connection ids are slot names. */
export interface FlowDefaults extends Partial<LlmNodeConfig> {
    agentId?: string;
}

export interface FlowWorkspacePolicy {
    mode: 'shared' | 'read-only' | 'worktree';
    base?: 'current' | 'head' | string;
    merge?: 'manual' | 'auto-if-clean' | 'discard';
    cleanup?: 'on-success' | 'always' | 'keep';
}

export interface FlowRunPolicy {
    maxNodes?: number;
    maxConcurrency?: number;
    timeoutMs?: number;
    /** Cumulative token ceiling across completed LLM nodes. */
    maxTokens?: number;
    workspace?: FlowWorkspacePolicy;
}

export interface FlowRunGoal {
    objective: string;
    constraints?: string[];
    acceptanceCriteria?: string[];
    status?: 'active' | 'paused' | 'completed' | 'blocked';
}

export interface FlowRevision {
    dependencyLocks?: Record<string, FlowDependencyLock>;
    outputs?: FlowDraft['outputs'];
    id: FlowId;
    revision: number;
    name: string;
    nodes: FlowNodeDefinition[];
    edges: FlowEdgeDefinition[];
    /** Declared runtime parameters (the workflow's variable inputs). */
    parameters?: FlowParameter[];
    variables?: FlowVariables;
    /** Named connection slots (frozen into the revision). */
    connections?: FlowConnection[];
    /** Connection slot name used when a node does not specify one. */
    defaultConnection?: string;
    /** Flow-level system prompt segments (frozen into the revision). */
    systemPrompt?: string[];
    /** Flow-level tool ids (frozen into the revision). */
    toolIds?: string[];
    /** Defaults inherited by builtin.agent nodes. */
    defaults?: FlowDefaults;
    /** Frozen runtime safety, concurrency and workspace defaults. */
    runPolicy?: FlowRunPolicy;
    createdAt: number;
    digest: string;
}

export interface FlowDependencyLock {
    flowId: string;
    revision: number;
    digest: string;
    children: Record<string, FlowDependencyLock>;
}

export interface BlobRef {
    uri: string;
    contentHash?: string;
    size?: number;
    mimeType?: string;
}

export type ArtifactContent =
    | string
    | JsonValue
    | Record<string, unknown>
    | BlobRef;

export interface Artifact {
    id: string;
    runId?: string;
    nodeRunId?: string;
    outputName: string;
    type: 'final-answer' | 'summary' | 'file' | 'json' | 'text' | 'control';
    content: ArtifactContent;
    contentHash: string;
    createdAt: number;
    metadata?: Record<string, JsonValue>;
}

export interface ArtifactDraft {
    outputName: string;
    type: 'text' | 'json' | 'file' | 'summary' | 'final-answer' | 'control';
    schema?: JsonSchemaRef;
    content: ArtifactContent;
    metadata?: Record<string, JsonValue>;
}

export function parseFlowId(value: string): FlowId {
    if (!value || value.includes('/') || value.includes('\\')) {
        throw new Error('Invalid FlowId');
    }
    return value as FlowId;
}

import type {
    ArtifactDraft,
    NodePortSchemas,
    InputPortSpec,
    JsonValue,
    JsonSchemaRef,
    OutputPortSpec,
    FlowEdgeId,
    FlowConnection,
    FlowRunGoal,
    FlowRunPolicy,
} from './flow-definition';

export interface DagPluginManifest<Config = unknown> {
    id: string;
    version: string;
    kind: string;
    title: string;
    category: string;
    configSchema: JsonValue;
    defaultConfig?: Partial<Config>;
    inputs: InputPortSpec[];
    outputs: OutputPortSpec[];
    authoring?: { invocation?: boolean; scopeRole?: 'route' | 'check' | 'aggregate' | 'judge' | 'input' | 'revise' | 'loop' | 'taskGroup' | 'join' };
    requiredCapabilities?: string[];
}

export interface DagNodeDefinition<Config = unknown> {
    assign?: Record<string, JsonValue>;
    outputPolicy?: { includeInRunOutput?: boolean; publishToHistory?: boolean };
    portSchemas?: NodePortSchemas;
    id: string;
    name: string;
    plugin: string;
    pluginVersion: string;
    config: Config;
    inputs: Record<string, unknown>;
    priority?: number;
    capabilities?: string[];
    budget?: Record<string, number>;
    retry?: { maxAttempts: number; backoffMs?: number };
    /** 本节点失败时执行的补偿节点 id（Saga 回滚）。 */
    compensate?: string;
}

export interface DagEdgeDefinition {
    id: string;
    from: string;
    to: string;
    output: string;
    input: string;
    /** Control edges order execution without contributing model input. */
    kind?: 'control' | 'data';
    /** 依赖失败时的下游行为。 */
    onFailure?: 'fail' | 'skip' | 'continue';
}

export interface DagRunSpec {
    variables?: import('./flow-definition').FlowVariables;
    variableScopes?: Record<string, import('./flow-definition').FlowVariables>;
    templateVersion?: 1;
    parameterScopes?: Record<string, { parent: string; source?: string; defaults: Record<string, JsonValue>; values: Record<string, JsonValue>; schema?: import('./flow-definition').FlowParameter[] }>;
    invocation?: { requestId: string; flowId: string; revision: number; digest: string; name: string; createdAt: number; branch?: string; head?: string | null };
    parameterSchema?: import('./flow-definition').FlowParameter[];
    /** Compiler-owned identity defaults by node; dynamic descendants inherit their parent's scope. */
    nodeDefaults?: Record<string, Record<string, unknown>>;
    /** Connection aliases for dynamic descendants, scoped by their compiled source node. */
    nodeConnections?: Record<string, { connections?: FlowConnection[]; defaultConnection?: string; fallbackConnectionId?: string; runConnectionId?: string }>;
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    maxNodes?: number;
    maxConcurrency?: number;
    timeoutMs?: number;
    maxTokens?: number;
    runPolicy?: FlowRunPolicy;
    goal?: FlowRunGoal;
}

export interface DagNodeContext<Config = unknown> {
    sessionId: string;
    nodeRunId: string;
    config: Config;
    inputs: Record<string, unknown>;
    dependencies: DagTaskDependencyBinding[];
}

export interface DagTaskDependencyBinding {
    taskId: string;
    nodeId?: string;
    input: string;
    output?: string;
    edgeId?: string;
    /** False keeps the dependency for scheduling but does not expose its output. */
    injectOutput?: boolean;
    onFailure?: 'fail' | 'skip' | 'continue';
}

export interface DagTaskDefinition {
    programKind: string;
    programVersion: string;
    input: unknown;
    priority?: number;
}

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export interface DagRuntimeContribution<Config = unknown> {
    validate?(config: Config): ValidationResult;
    createTask(context: DagNodeContext<Config>): DagTaskDefinition;
    mapOutput?(output: unknown): DagNodeOutcome;
}

export interface DagUIContribution<Config = unknown> {
    palette: {
        label: string;
        group: string;
        icon?: string;
        colorToken?: string;
    };
    node: {
        summarize(config: Config): string;
        renderer?: string;
    };
    inspector: {
        layout?: FormLayout;
        customEditor?: string;
    };
}

export interface DagPluginPresentation {
    manifest: DagPluginManifest;
    ui?: DagUIContribution;
}

export interface FormLayout {
    sections: Array<{
        id: string;
        title?: string;
        fields: string[];
    }>;
}

export interface DagPlugin<Config = unknown> {
    manifest: DagPluginManifest<Config>;
    runtime: () => Promise<DagRuntimeContribution<Config>>;
    ui?: () => Promise<DagUIContribution<Config>>;
}

export interface DagPluginCatalog {
    getSchema?(ref: JsonSchemaRef): JsonValue | undefined;
    listManifests(): DagPluginManifest[];
    getManifest(id: string, version?: string): DagPluginManifest | undefined;
    loadRuntime(id: string, version?: string): Promise<DagRuntimeContribution>;
    loadUI(id: string, version?: string): Promise<DagUIContribution | undefined>;
}

export type GraphEffect =
    | { type: 'activate-edge'; edgeId: FlowEdgeId }
    | { type: 'disable-edge'; edgeId: FlowEdgeId }
    | { type: 'patch-graph'; patch: GraphPatch }
    | { type: 'cancel-tasks'; tasks: Array<{ nodeId: string; taskId: string }>; reason: string };

export interface GraphPatch {
    idempotencyKey: string;
    nodes: DagNodeDefinition[];
    edges: Array<{
        id: string;
        from: string;
        to: string;
        input?: string;
        output?: string;
        kind?: 'control' | 'data';
        onFailure?: 'fail' | 'skip' | 'continue';
    }>;
}

export interface DagNodeOutcome {
    outputs: Record<string, ArtifactDraft>;
    effects?: GraphEffect[];
}

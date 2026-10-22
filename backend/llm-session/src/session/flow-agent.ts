import { prepareFlowRun, prepareFlowParameters, type FlowDefinitionStore } from '@itookit/llm-flow';
import type { DagPluginCatalog, FlowRevision, JsonValue } from '@itookit/llm-flow/contracts';
import type { ExecutorConfig, TaskInput } from '../core/types';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import type { SessionHost } from '../utils/host-ports';
import { captureFlowConnections } from './flow-connection-snapshot';
import { prepareFlowConnections, type FlowConnectionCatalog } from './flow-connections';
import { bindFlowNode, type FlowIdentityResolver } from './flow-node-binder';
import { bindFlowAgentConnection, preferredTaskConnection } from './flow-agent-connections';
import { captureFlowIdentities } from './flow-identity-snapshot';
import { bindPlannedFlowGraph, createFlowRunPlan, freezePlannedFlowConnections, validatePlannedFlowConnections } from './flow-run-plan';

export interface FlowAgentPorts {
    definitions: Pick<FlowDefinitionStore, 'loadRevision'>;
    resolveAgent(id: string): Promise<ExecutorConfig>;
    prepareConnections(flow: FlowRevision, bindings?: Record<string, string>, connectionId?: string): Promise<FlowRevision>;
    connectionCatalog?: FlowConnectionCatalog;
    identityResolver: FlowIdentityResolver;
    plugins?: DagPluginCatalog;
    host: Pick<SessionHost, 'logger'>;
}

/** Bind the selected Agent once, before a durable instruction is accepted. */
export async function prepareFlowAgentInput(input: TaskInput, ports: FlowAgentPorts): Promise<TaskInput> {
    if (input.instructionFlowBinding) return input;
    const explicit = input.sendIntent?.execution.kind === 'flow' ? input.sendIntent.execution : undefined;
    const agent = await ports.resolveAgent(input.agentId);
    if (!explicit && agent.execution?.kind !== 'flow') return input;
    const started = Date.now(), operationId = input.sendIntent?.submission?.id ?? `${input.sessionId}:${input.agentId}`;
    let stage = 'definition';
    try {
        const binding = explicit ?? agent.execution as Extract<NonNullable<ExecutorConfig['execution']>, { kind: 'flow' }>;
        const definition = await requiredRevision(ports, binding.flowId, binding.revision);
        stage = 'parameters';
        const parameters = boundParameters(definition, binding.parameters, input.overrides?.flowParameters);
        const connectionBindings = { ...binding.connectionBindings, ...input.overrides?.flowConnectionBindings };
        stage = 'dependencies';
        const frozen = await freezeDependencies(ports, definition, input, connectionBindings, parameters, agent);
        const sendIntent = { ...input.sendIntent, branch: input.sendIntent?.branch ?? { mode: 'continue' as const },
            retention: input.sendIntent?.retention ?? { mode: 'persistent' as const },
            execution: { kind: 'flow' as const, flowId: definition.id, revision: definition.revision, parameters, connectionBindings } };
        ports.host.logger.info('Flow Agent admitted', { operation: 'agent.flow', stage: 'admission', result: 'success',
            operationId, agentId: agent.id, flowId: definition.id, revision: definition.revision,
            parameterCount: Object.keys(parameters).length, dependencyCount: frozen.dependencies.length,
            connectionCount: frozen.connections.connections.length, nodeCount: frozen.plan.graph.nodes.length,
            planVersion: frozen.plan.version, elapsedMs: Date.now() - started });
        return { ...input, sendIntent, instructionFlowBinding: structuredClone({ definition, ...frozen, agent,
            ...(explicit ? { source: 'explicit' as const } : {}) }) };
    } catch (error) {
        ports.host.logger.warn('Flow Agent admission failed', { operation: 'agent.flow', stage, result: 'failure',
            operationId, agentId: agent.id, errorCategory: stage === 'definition' ? 'flow-unavailable' : `invalid-${stage}`,
            errorCode: admissionErrorCode(error, stage), elapsedMs: Date.now() - started });
        throw error;
    }
}

async function requiredRevision(ports: FlowAgentPorts, id: string, revision?: number): Promise<FlowRevision> {
    if (typeof id !== 'string' || !id || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) {
        throw new ConversationError(ConversationErrorCode.AGENT_DISABLED, 'Agent has an invalid Flow binding');
    }
    const flow = await ports.definitions.loadRevision(id, revision);
    if (!flow) throw new ConversationError(ConversationErrorCode.AGENT_DISABLED, `Agent Flow unavailable: ${id}${revision === undefined ? '' : `@${revision}`}`);
    return flow;
}

function boundParameters(flow: FlowRevision, defaults: Record<string, unknown> | undefined,
    supplied: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
    if (defaults !== undefined && !record(defaults) || supplied !== undefined && !record(supplied)) throw new Error('Flow Agent parameters must be an object');
    const values = { ...defaults, ...supplied } as Record<string, JsonValue>;
    const names = new Set(flow.parameters?.map(field => field.name));
    for (const name of Object.keys(values)) if (!names.has(name)) throw new Error(`Unknown Flow parameter: ${name}`);
    return prepareFlowParameters(flow.parameters, values);
}

async function freezeDependencies(ports: FlowAgentPorts, flow: FlowRevision, input: TaskInput, bindings: Record<string, string>,
    parameters: Record<string, JsonValue>, agent: ExecutorConfig) {
    const revisions = new Map<string, FlowRevision>();
    const identities = captureFlowIdentities(ports.identityResolver, input.sessionId);
    const capture = ports.connectionCatalog && captureFlowConnections(ports.connectionCatalog);
    const prepare = capture ? (definition: FlowRevision, values?: Record<string, string>, runId?: string) =>
        prepareFlowConnections(definition, values, capture.catalog, input.instructionConnectionBinding?.defaults, runId) : ports.prepareConnections;
    const graph = await prepareFlowRun(flow, { parameters, plugins: ports.plugins,
        bindNode: (node, defaults) => bindFlowAgentConnection(node, defaults, identities.resolver, preferredTaskConnection(input)),
        fallbackConnectionId: input.instructionConnectionBinding?.connectionId ?? input.overrides?.connectionId,
        connectionId: input.overrides?.connectionId, connectionBindings: bindings, prepareConnections: prepare,
        resolveComposite: async (id, revision) => {
            const found = await requiredRevision(ports, id, revision);
            revisions.set(`${found.id}@${found.revision}`, found);
            return found;
        } });
    const bound = await bindPlannedFlowGraph(graph, (node, defaults) => bindFlowNode(node, defaults,
        { blocks: [], canonicalMessages: [] }, { sessionId: input.sessionId, input: { ...input, text: '' } },
        { roundId: 'admission', config: agent }, identities.resolver));
    const admitted = capture ? await validatePlannedFlowConnections(bound, flow, capture.catalog, input.instructionConnectionBinding?.defaults) : bound;
    return { dependencies: [...revisions.values()], connections: capture?.snapshot() ?? { connections: [] },
        plan: createFlowRunPlan(freezePlannedFlowConnections(graph, admitted), identities.snapshot()) };
}

/** Runtime resolution is closed over accepted definitions, never the mutable Flow library. */
export function frozenFlowResolver(input: TaskInput, fallback: FlowAgentPorts['definitions']['loadRevision']) {
    const binding = input.instructionFlowBinding;
    if (!binding) return fallback;
    return async (id: string, revision?: number): Promise<FlowRevision | null> => {
        const candidates = binding.dependencies.filter(flow => flow.id === id && (revision === undefined || flow.revision === revision));
        return structuredClone(candidates.sort((a, b) => b.revision - a.revision)[0] ?? null);
    };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function admissionErrorCode(error: unknown, stage: string): string {
    const message = error instanceof Error ? error.message : '';
    if (/changed after admission/i.test(message)) return 'connection-changed';
    if (/agent reference cannot be resolved/i.test(message)) return 'agent-reference-unavailable';
    if (/system prompt.*(?:resolved|not found)/i.test(message)) return 'prompt-reference-unavailable';
    if (/MCP profile/i.test(message)) return 'mcp-profile-unavailable';
    if (/missing connection|connection not found|connection.*unavailable|lacks credentials/i.test(message)) return 'connection-unavailable';
    if (/unknown model|capability|unsupported.*model|model.*support/i.test(message)) return 'model-incompatible';
    if (/connection.*binding|connection slot/i.test(message)) return 'connection-binding';
    if (/digest|dependency lock/i.test(message)) return 'definition-digest';
    if (/max.*nodes|node.*limit|maximum.*nodes/i.test(message)) return 'node-limit';
    if (/unknown flow parameter/i.test(message)) return 'unknown-parameter';
    if (/parameter.*must be|parameters must be/i.test(message)) return 'parameter-type';
    if (/parameter.*(?:minimum|maximum|length|range|pattern|enum)/i.test(message)) return 'parameter-constraint';
    if (/flow.*(?:unavailable|not found)|composite.*not found/i.test(message) || stage === 'definition') return 'flow-unavailable';
    return stage === 'parameters' ? 'invalid-parameters' : 'invalid-definition';
}

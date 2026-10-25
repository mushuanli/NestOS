import { prepareFlowRun, prepareFlowCallInput, type FlowDefinitionStore } from '@itookit/llm-flow';
import { assertRootCallable, assertSelectedTarget, flowTargetRevision, type DagPluginCatalog, type FlowRevision, type JsonValue, type FlowCallSource } from '@itookit/llm-flow/contracts';
import type { ExecutorConfig, TaskInput } from '../core/types';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import type { SessionHost } from '../utils/host-ports';
import { captureFlowConnections } from './flow-connection-snapshot';
import { prepareFlowConnections, type FlowConnectionCatalog } from './flow-connections';
import { bindFlowNode, type FlowIdentityResolver } from './flow-node-binder';
import { bindFlowAgentConnection, preferredTaskConnection } from './flow-agent-connections';
import { captureFlowIdentities } from './flow-identity-snapshot';
import { bindPlannedFlowGraph, createFlowRunPlan, freezePlannedFlowConnections, validatePlannedFlowConnections } from './flow-run-plan';
import {flowTargetIdentity, flowTargetRef} from './flow-target';

export interface FlowAgentPorts {
    validateCallAssets?: import('../contracts/submission').CallAssetValidator;
    definitions: Pick<FlowDefinitionStore, 'loadRevision'>;
    resolveAgent(id: string): Promise<ExecutorConfig>;
    prepareConnections(flow: FlowRevision, bindings?: Record<string, string>, connectionId?: string): Promise<FlowRevision>;
    connectionCatalog?: FlowConnectionCatalog;
    identityResolver: FlowIdentityResolver;
    plugins?: DagPluginCatalog;
    host: Pick<SessionHost, 'logger'>;
}

type FlowExecution = Extract<NonNullable<ExecutorConfig['execution']>, {kind: 'flow'}>;
interface FlowSelection {agent?: ExecutorConfig; target?: TaskInput['target']; explicit?: FlowExecution}
interface AdmissionTrace {operationId: string; started: number; stage: string}

/** Bind Agent implementations and independent Flow targets before durable queue acceptance. */
export async function prepareFlowAgentInput(input: TaskInput, ports: FlowAgentPorts): Promise<TaskInput> {
    if (input.instructionFlowBinding) return input;
    const explicit = input.sendIntent?.execution.kind === 'flow' ? input.sendIntent.execution : undefined;
    const target = input.target?.kind === 'flow' ? input.target : undefined;
    const agent = target ? undefined : await ports.resolveAgent(input.agentId);
    if (!target && !explicit && agent?.execution?.kind !== 'flow') return input;
    return admitFlowInput(input, ports, {target, agent, explicit});
}

async function admitFlowInput(input: TaskInput, ports: FlowAgentPorts, selected: FlowSelection): Promise<TaskInput> {
    const trace: AdmissionTrace = {started: Date.now(), stage: 'definition',
        operationId: input.sendIntent?.submission?.id ?? input.invocation?.invocationId ?? `${input.sessionId}:${input.agentId}`};
    try {
        const admitted = await prepareSelectedFlow(input, ports, selected, trace);
        reportAdmitted(admitted, ports, selected, trace);
        return admitted;
    } catch (error) {
        const {target, agent} = selected;
        ports.host.logger.warn(target ? 'Flow target admission failed' : 'Flow Agent admission failed', {
            operation: target ? 'flow.submit' : 'agent.flow', stage: trace.stage, result: 'failure', operationId: trace.operationId,
            ...(agent ? {agentId: agent.id} : {targetKind: 'flow', targetId: target?.id}),
            errorCategory: trace.stage === 'definition' ? 'flow-unavailable' : `invalid-${trace.stage}`,
            errorCode: admissionErrorCode(error, trace.stage), elapsedMs: Date.now() - trace.started});
        throw error;
    }
}

async function prepareSelectedFlow(input: TaskInput, ports: FlowAgentPorts, selected: FlowSelection, trace: AdmissionTrace): Promise<TaskInput> {
    const {target, agent, explicit} = selected;
    const binding: {flowId: string; revision?: number; parameters?: Record<string, unknown>; connectionBindings?: Record<string, string>}
        = target ? {flowId: target.id, revision: flowTargetRevision(target)} : explicit ?? agent!.execution as FlowExecution;
    const definition = await requiredRevision(ports, binding.flowId, binding.revision);
    assertRootCallable(definition);
    if (target) assertSelectedTarget(target, flowTargetRef(definition));
    trace.stage = 'parameters';
    const inputResolution = boundParameters(definition, binding.parameters, input.overrides, input.source);
    trace.stage = 'assets'; await ports.validateCallAssets?.(input.sessionId, inputResolution.parameters);
    const parameters = inputResolution.parameters, connectionBindings = {...binding.connectionBindings, ...input.overrides?.flowConnectionBindings};
    trace.stage = 'dependencies';
    const frozen = await freezeDependencies(ports, definition, input, connectionBindings, parameters, agent ?? flowTargetIdentity(definition));
    const sendIntent = {...input.sendIntent, branch: input.sendIntent?.branch ?? {mode: 'continue' as const},
        retention: input.sendIntent?.retention ?? {mode: 'persistent' as const},
        execution: {kind: 'flow' as const, flowId: definition.id, revision: definition.revision, parameters, connectionBindings}};
    return {...input, sendIntent, instructionFlowBinding: structuredClone({definition, ...frozen, inputResolution,
        ...(target ? {source: 'target' as const, target: flowTargetRef(definition)} : {agent: agent!, ...(explicit ? {source: 'explicit' as const} : {})})})};
}

function reportAdmitted(input: TaskInput, ports: FlowAgentPorts, selected: FlowSelection, trace: AdmissionTrace): void {
    const {target, agent} = selected, binding = input.instructionFlowBinding!, plan = binding.plan!;
    ports.host.logger.info(target ? 'Flow target admitted' : 'Flow Agent admitted', {operation: target ? 'flow.submit' : 'agent.flow',
        stage: 'admission', result: 'success', operationId: trace.operationId,
        ...(agent ? {agentId: agent.id} : {targetKind: 'flow'}), flowId: binding.definition.id, revision: binding.definition.revision,
        parameterCount: Object.keys(binding.inputResolution!.parameters).length, dependencyCount: binding.dependencies.length,
        connectionCount: binding.connections.connections.length, nodeCount: plan.graph.nodes.length,
        planVersion: plan.version, elapsedMs: Date.now() - trace.started});
}

async function requiredRevision(ports: FlowAgentPorts, id: string, revision?: number): Promise<FlowRevision> {
    if (typeof id !== 'string' || !id || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) {
        throw new ConversationError(ConversationErrorCode.AGENT_DISABLED, 'Agent has an invalid Flow binding');
    }
    const flow = await ports.definitions.loadRevision(id, revision);
    if (!flow) throw new ConversationError(ConversationErrorCode.AGENT_DISABLED, `Agent Flow unavailable: ${id}${revision === undefined ? '' : `@${revision}`}`);
    return flow;
}

function boundParameters(flow: FlowRevision, defaults: Record<string, unknown> | undefined, overrides: TaskInput['overrides'], source?: FlowCallSource) {
    const supplied = overrides?.flowParameters;
    if (defaults !== undefined && !record(defaults) || supplied !== undefined && !record(supplied)) throw new Error('Flow Agent parameters must be an object');
    if (source && supplied !== undefined) throw Object.assign(new Error('Flow parameters and source cannot both be supplied'), {code: 'FLOW_INPUT_CONFLICT'});
    return prepareFlowCallInput(flow, source ?? {kind: 'arguments', value: supplied ?? {}}, {
        defaults: defaults as Record<string, JsonValue> | undefined, expected: overrides?.flowExpectedSignature});
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
    const code = (error as {code?: unknown} | undefined)?.code;
    if (code === 'FLOW_INPUT_SIGNATURE_CHANGED' || code === 'CALLABLE_LOCAL_ONLY' || code === 'CALLABLE_EXPOSURE_INVALID') return code;
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

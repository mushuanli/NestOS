import { checkFlowSyntax, flowToDag, mergeAgentConfig, type FlowNodeBinder } from '@itookit/llm-flow';
import type { FlowDefinitionStore } from '@itookit/llm-flow';
import type { IAgentConfigService } from '../contracts';
import { flowParameterValues, validateFlowInputGroups, type DagPluginCatalog, type FlowDraft, type FlowRevision, type JsonValue } from '@itookit/llm-flow/contracts';
import { admitFlowConnectionSlot, prepareFlowConnections } from './flow-connections';
import { bindFlowAgentConnection } from './flow-agent-connections';
import { AgentResolver } from './agent-resolver';
import {inferFlowConnectionRequirements} from '../contracts/flow-connection-policy';
import {ulid} from '../persistence/ulid';
import {createSessionHost, type SessionLogger} from '../utils/host-ports';

export interface FlowConnectionCheckInput {
    flow?: FlowDraft | FlowRevision;
    flowId?: string;
    revision?: number;
    connectionId?: string;
    connectionBindings?: Record<string, string>;
    agentId?: string;
    parameters?: Record<string, JsonValue>;
}

/** Compile connection admission without creating a Session, executing nodes or probing models. */
export async function checkFlowConnections(input: FlowConnectionCheckInput, agents: IAgentConfigService, definitions?: Pick<FlowDefinitionStore, 'loadRevision'>, plugins?: DagPluginCatalog,
    log: SessionLogger = createSessionHost().logger): Promise<{valid: true}> {
    const operationId = ulid(), started = performance.now();
    try {
        const result = await performFlowConnectionCheck(input, agents, definitions, plugins);
        log.info('flow.connections.check', {operationId, stage: 'admission', result: 'success', durationMs: Math.round(performance.now() - started)});
        return result;
    } catch (error) {
        log.warn('flow.connections.check', {operationId, stage: 'admission', result: 'failure', code: checkErrorCode(error), durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}

async function performFlowConnectionCheck(input: FlowConnectionCheckInput, agents: IAgentConfigService, definitions?: Pick<FlowDefinitionStore, 'loadRevision'>, plugins?: DagPluginCatalog): Promise<{valid: true}> {
    const source = input.flow ?? (input.flowId && input.revision !== undefined ? await definitions?.loadRevision(input.flowId, input.revision) : undefined);
    if (!source) throw connectionError('Flow definition is unavailable');
    const checked = checkFlowSyntax(source, {plugins});
    if (!checked.valid || !checked.flow) throw connectionError(checked.diagnostics.map(issue => issue.message).join('; '));
    const values = flowParameterValues(checked.flow.parameters, input.parameters, checked.flow.inputGroups);
    const inputIssues = validateFlowInputGroups(checked.flow.parameters, checked.flow.inputGroups, values, {allowInteractiveMissing: true});
    if (inputIssues.length) throw connectionError(inputIssues.map(issue => issue.message).join('; '));
    const agent = input.agentId ? await agents.getAgentConfig(input.agentId) : undefined;
    if (input.agentId && !agent) throw connectionError('Agent definition is unavailable');
    const defaults = { ...await agents.getModelDefaults?.() ?? {}, ...agent?.modelDefaults };
    const fallback = defaults.chat ?? (await agents.getDefaultConnection())?.id;
    const resolver = new AgentResolver(agents);
    try {
        await flowToDag(checked.flow, (node, inherited, context) => bindCheckedConnections(node, inherited, resolver, context), fallback,
            definitions ? (id, revision) => definitions.loadRevision(id, revision) : undefined, [], checked.flow.dependencyLocks, false,
            input.connectionId, input.connectionBindings,
            (flow, bindings, runConnectionId) => prepareFlowConnections(flow, bindings, agents, defaults, runConnectionId), input.parameters);
        return {valid: true};
    } catch (error) { throw Object.assign(connectionError(error instanceof Error ? error.message : 'Flow connection admission failed', checkErrorCode(error)),
        {field: (error as {field?: string})?.field}); }
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Preflight resolves only connection choices; runtime binding retains prompt and tool authority. */
const bindCheckedConnections: (node: Parameters<FlowNodeBinder>[0], defaults: Parameters<FlowNodeBinder>[1], resolver: AgentResolver,
    context: Parameters<FlowNodeBinder>[2]) => ReturnType<FlowNodeBinder> = async (node, defaults, resolver, context) => {
    const bound = await bindFlowAgentConnection(node, defaults, resolver, context?.runConnectionId);
    if (node.plugin !== 'builtin.agent') return bound;
    const config = bound.config ?? mergeAgentConfig(record(defaults), node.config), delegation = record(record(config).delegation);
    if (delegation.enabled !== true || !Array.isArray(delegation.agents)) return bound;
    const resolvedTemplates = Object.fromEntries(await Promise.all(delegation.agents.map(async candidate => {
        const agentId = record(candidate).agentId;
        if (typeof agentId !== 'string' || !agentId.trim()) throw connectionError('Delegation Agent identity is invalid');
        const child = { ...node, config: { ...record(delegation.template), agentId } as typeof node.config };
        const patch = await bindFlowAgentConnection(child, defaults, resolver, context?.runConnectionId);
        return [agentId, { plugin: 'builtin.agent', pluginVersion: '1.0.0', config: patch.config ?? mergeAgentConfig(record(defaults), child.config) }];
    })));
    return { config: { ...record(config), delegation: { ...delegation, resolvedTemplates } } as typeof node.config };
};

function checkErrorCode(error: unknown): string {
    const code = (error as {code?: unknown} | undefined)?.code;
    return typeof code === 'string' && /^FLOW_CONNECTION_[A-Z_]{1,64}$/.test(code) ? code : 'FLOW_CONNECTION_INVALID';
}
function connectionError(message: string, code = 'FLOW_CONNECTION_INVALID'): Error { return Object.assign(new Error(message), {code}); }

/** Check named slots without constructing or compiling a synthetic Flow graph. */
export async function checkFlowConnectionSlots(input: Pick<FlowConnectionCheckInput, 'flow' | 'parameters'>, agents: IAgentConfigService): Promise<Array<{code: string; field: string; message: string}>> {
    if (!input.flow) throw connectionError('Flow definition is unavailable');
    const values = flowParameterValues(input.flow.parameters, input.parameters, input.flow.inputGroups);
    const issues: Array<{code: string; field: string; message: string}> = [];
    for (const slot of inferFlowConnectionRequirements(input.flow, values)) {
        if (slot.required === false && !slot.connectionId) continue;
        try {await admitFlowConnectionSlot(slot, slot.connectionId, agents);}
        catch (error) {issues.push({code: checkErrorCode(error), field: slot.name, message: error instanceof Error ? error.message : 'Connection admission failed'});}
    }
    return issues;
}

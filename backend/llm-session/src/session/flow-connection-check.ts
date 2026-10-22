import { checkFlowSyntax, flowToDag } from '@itookit/llm-flow';
import type { FlowDefinitionStore } from '@itookit/llm-flow';
import type { IAgentConfigService } from '../contracts';
import type { DagPluginCatalog, FlowDraft, FlowRevision } from '@itookit/llm-flow/contracts';
import { prepareFlowConnections } from './flow-connections';

export interface FlowConnectionCheckInput {
    flow?: FlowDraft | FlowRevision;
    flowId?: string;
    revision?: number;
    connectionId?: string;
    connectionBindings?: Record<string, string>;
}

/** Compile connection admission without creating a Session, executing nodes or probing models. */
export async function checkFlowConnections(input: FlowConnectionCheckInput, agents: IAgentConfigService, definitions?: Pick<FlowDefinitionStore, 'loadRevision'>, plugins?: DagPluginCatalog): Promise<{valid: true}> {
    const source = input.flow ?? (input.flowId && input.revision !== undefined ? await definitions?.loadRevision(input.flowId, input.revision) : undefined);
    if (!source) throw connectionError('Flow definition is unavailable');
    const checked = checkFlowSyntax(source, {plugins});
    if (!checked.valid || !checked.flow) throw connectionError(checked.diagnostics.map(issue => issue.message).join('; '));
    const fallback = (await agents.getDefaultConnection())?.id;
    try {
        await flowToDag(checked.flow, undefined, fallback,
            definitions ? (id, revision) => definitions.loadRevision(id, revision) : undefined, [], checked.flow.dependencyLocks, false,
            input.connectionId, input.connectionBindings,
            (flow, bindings, runConnectionId) => prepareFlowConnections(flow, bindings, agents, undefined, runConnectionId));
        return {valid: true};
    } catch (error) { throw connectionError(error instanceof Error ? error.message : 'Flow connection admission failed'); }
}

function connectionError(message: string): Error { return Object.assign(new Error(message), {code: 'FLOW_CONNECTION_INVALID'}); }

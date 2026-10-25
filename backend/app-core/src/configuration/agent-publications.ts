import {checkFlowSource, prepareFlowCallInput, type FlowDefinitionStore} from '@itookit/llm-flow';
import {assertRootCallable, type DagPluginCatalog, type JsonValue} from '@itookit/llm-flow/contracts';
import type {AgentExecution, AgentRevisionContent} from '@itookit/kernel-adapters/contracts';

/** Agent publication freezes a validated implementation revision while preserving public required inputs. */
export function createAgentPublicationDependencies(definitions: FlowDefinitionStore, plugins?: DagPluginCatalog) {
    return {resolveFlow: async (execution: Extract<AgentExecution, {kind: 'flow'}>): Promise<NonNullable<AgentRevisionContent['flow']>> => {
        const flow = await definitions.loadRevision(execution.flowId, execution.revision);
        if (!flow) throw invalid('AGENT_PUBLICATION_FLOW_UNAVAILABLE');
        assertRootCallable(flow);
        const checked = await checkFlowSource(flow, {plugins, resolveComposite: (id, revision) => definitions.loadRevision(id, revision)});
        if (!checked.valid) throw invalid('AGENT_PUBLICATION_FLOW_INVALID');
        try {
            prepareFlowCallInput({...flow, parameters: flow.parameters?.map(parameter => ({...parameter, required: false})), inputGroups: undefined},
                {kind: 'arguments', value: (execution.parameters ?? {}) as JsonValue}, {allowUndeclared: flow.parameters === undefined});
        } catch {throw invalid('AGENT_PUBLICATION_DEFAULTS_INVALID');}
        return {id: flow.id, revision: flow.revision, digest: flow.digest};
    }};
}
function invalid(code: string): Error {return Object.assign(new Error(code), {code});}

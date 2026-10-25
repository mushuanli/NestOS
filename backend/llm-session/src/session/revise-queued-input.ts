import type {DagPluginCatalog} from '@itookit/llm-flow/contracts';
import type {SessionInstruction} from '../contracts/instruction-queue';
import type {SessionHost} from '../utils/host-ports';
import type {FlowIdentityResolver} from './flow-node-binder';
import {prepareFlowAgentInput} from './flow-agent';
import {boundFlowIdentity} from './flow-target';
import {frozenFlowIdentities} from './flow-identity-snapshot';
import {frozenFlowConnections} from './flow-connection-snapshot';
import {prepareFlowConnections, type FlowConnectionCatalog} from './flow-connections';

/** Recompile edited arguments from the accepted recipe, without re-reading definitions or Agent policies. */
export async function reviseQueuedInput(sessionId: string, item: SessionInstruction, live: FlowConnectionCatalog & FlowIdentityResolver,
    plugins: DagPluginCatalog | undefined, host: SessionHost, validateCallAssets?: import('../contracts/submission').CallAssetValidator): Promise<SessionInstruction> {
    const binding = item.flowBinding;
    if (!binding) {
        if (item.source?.kind !== 'composer' || Object.keys(item.source.values).length)
            throw Object.assign(new Error('This Agent does not accept structured arguments'), {code: 'CALL_INPUT_UNBOUND'});
        return item;
    }
    if (!binding.plan) throw Object.assign(new Error('The accepted instruction has no frozen input plan'), {code: 'QUEUE_INPUT_PLAN_UNAVAILABLE'});
    const catalog = frozenFlowConnections(live, binding.connections), identity = boundFlowIdentity(binding)!;
    const definitions = [binding.definition, ...binding.dependencies];
    const input = await prepareFlowAgentInput({...item, sessionId, instructionConnectionBinding: item.connectionBinding}, {
        validateCallAssets,
        definitions: {loadRevision: async (id, revision) => structuredClone(definitions.find(flow => flow.id === id
            && (revision === undefined || flow.revision === revision)) ?? null)},
        resolveAgent: async () => structuredClone(identity), identityResolver: frozenFlowIdentities(binding.plan.identities),
        connectionCatalog: catalog, prepareConnections: (flow, bindings, connectionId) =>
            prepareFlowConnections(flow, bindings, catalog, item.connectionBinding?.defaults, connectionId), plugins, host,
    });
    return {...item, sendIntent: input.sendIntent, flowBinding: input.instructionFlowBinding};
}

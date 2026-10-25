import type {Round} from '../contracts/conversation';
import type {TaskInput, ExecutionOverrides} from '../core/types';

/** A new invocation may reuse a published Flow target; it must not fall back to an Agent. */
export function roundCallTarget(round: Round | null | undefined, overrides?: ExecutionOverrides, changeAgent = false):
    Pick<TaskInput, 'target' | 'expectedTarget' | 'source' | 'sendIntent' | 'overrides' | 'agentId'> | Record<never, never> {
    if (changeAgent || !round?.target) return {};
    if (round.target.kind === 'agent') return agentRoundTarget(round, overrides);
    if (!round.flow) return {};
    const {flowParameters, flowExpectedSignature: _signature, ...rest} = overrides ?? {};
    const flow = round.flow;
    return {agentId: '', target: {kind: 'flow', id: round.target.id, version: round.target.version},
        source: {kind: 'arguments', value: structuredClone(flowParameters ?? flow.parameters ?? {})}, overrides: {...rest,
            flowExpectedSignature: {id: flow.flowId, revision: Number(round.target.version), digest: round.target.digest}},
        sendIntent: {branch: {mode: 'continue'}, retention: {mode: 'persistent'}, execution: {kind: 'flow', flowId: flow.flowId,
            revision: Number(round.target.version), connectionBindings: structuredClone(flow.connectionBindings)}}};
}

function agentRoundTarget(round: Round, overrides?: ExecutionOverrides): Pick<TaskInput, 'target' | 'expectedTarget' | 'source' | 'overrides' | 'agentId'> {
    const target = round.target!, flow = round.flow;
    const {flowParameters: _consumedParameters, ...remaining} = overrides ?? {};
    return {agentId: target.id, target: {kind: 'agent', id: target.id, version: target.version}, expectedTarget: structuredClone(target),
        ...(flow ? {source: {kind: 'arguments', value: structuredClone(overrides?.flowParameters ?? flow.parameters ?? {})}} : {}),
        overrides: overrides ? flow ? remaining : {...overrides} : undefined};
}

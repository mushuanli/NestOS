import type {FlowRevision, TargetRef} from '@itookit/llm-flow/contracts';
import type {ExecutorConfig} from '../core/types';
import type {SessionInstruction} from '../contracts/instruction-queue';

export function flowTargetRef(flow: FlowRevision): TargetRef {
    return {kind: 'flow', id: flow.id, version: String(flow.revision), digest: flow.digest};
}

/** A Flow is an execution identity in its own right, without a synthetic Agent definition. */
export function flowTargetIdentity(flow: FlowRevision): ExecutorConfig {
    return {id: flow.id, name: flow.name, type: 'flow', target: flowTargetRef(flow),
        ...(flow.exposure !== undefined ? {exposure: flow.exposure} : {}), systemPrompt: [],
        execution: {kind: 'flow', flowId: flow.id, revision: flow.revision}};
}

export function boundFlowIdentity(binding: SessionInstruction['flowBinding']): ExecutorConfig | undefined {
    if (!binding || binding.source !== 'target') return binding?.agent;
    const expected = flowTargetRef(binding.definition), actual = binding.target;
    if (binding.agent || !actual || Object.entries(expected).some(([key, value]) => actual[key as keyof TargetRef] !== value))
        throw Object.assign(new Error('Invalid admitted Flow target identity'), {code: 'FLOW_TARGET_IDENTITY_INVALID'});
    return flowTargetIdentity(binding.definition);
}

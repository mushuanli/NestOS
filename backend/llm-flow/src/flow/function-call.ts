import type { DagNodeDefinition, DagRunSpec, FlowRevision } from '../contracts';
import { RETURN_NODE } from './function-outputs';

/** A durable value task evaluates parent bindings exactly once before the child starts. */
export function callEntry(call: DagNodeDefinition): DagNodeDefinition {
    if (Object.keys(call.retry ?? {}).length || call.compensate || Object.keys(call.assign ?? {}).length || Object.keys(call.budget ?? {}).length || call.capabilities?.length) {
        throw new Error(`Flow call ${call.id}: retry, compensate, assign, budget and capabilities must be configured inside the child`);
    }
    if (Object.keys(call.inputs).length) throw new Error(`Flow call ${call.id}: use parameters instead of inputs`);
    const config = call.config as { parameters?: Record<string, unknown> };
    if (config.parameters !== undefined && (!config.parameters || Array.isArray(config.parameters) || typeof config.parameters !== 'object')) {
        throw new Error(`Flow call ${call.id}: parameters must be an object`);
    }
    return { id: `${call.id}__input`, name: `${call.name} · input`, priority: call.priority, plugin: 'builtin.transform', pluginVersion: '1.0.0',
        inputs: {}, config: { value: config.parameters ?? {}, outputName: 'result', type: 'json' } };
}

export function assertCallable(flow: FlowRevision, child: DagRunSpec): void {
    const policy = flow.runPolicy ?? {};
    if (Object.values(policy).some(value => value !== undefined)) {
        throw new Error(`Flow ${flow.id}: child runPolicy is not supported; configure limits and workspace on the parent`);
    }
    if (!flow.outputs || !child.nodes.some(node => node.id === RETURN_NODE)) {
        throw new Error(`Flow ${flow.id}: function calls require declared outputs`);
    }
}

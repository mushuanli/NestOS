import type { DagNodeDefinition, DagRunSpec, JsonValue } from '../../contracts';
import { findCycles } from '../graph';
import { resolveFlowParameters } from '../parameters';
import { object } from './value';
import { scopedParameters } from './references';
import { validateDispatch } from './validation';

/** Apply the owning Run workspace to invocation templates before they are bound. */
export function withDispatchWorkspace(node: DagNodeDefinition, directory?: string): DagNodeDefinition {
    if (!directory) return node;
    const config = object(node.config);
    if (node.plugin === 'builtin.agent') return { ...node, config: { ...config,
        workingDirectory: config.workingDirectory ?? directory } } as DagNodeDefinition;
    if (node.plugin !== 'builtin.route' || node.pluginVersion !== '2.0.0') return node;
    const branches = Array.isArray(config.branches) ? config.branches.map(value => {
        const branch = object(value);
        return { ...branch, target: withDispatchWorkspace(branch.target as DagNodeDefinition, directory) };
    }) : config.branches;
    const revision = object(config.revision), invocation = object(revision.invocation);
    return { ...node, config: { ...config, branches, ...(revision.invocation ? { revision: { ...revision,
        invocation: { ...invocation, target: withDispatchWorkspace(invocation.target as DagNodeDefinition, directory) } } } : {}) } } as DagNodeDefinition;
}

/** Reserve the worst-case child count before creating any task, across every scope. */
export function validateDispatchCapacity(spec: DagRunSpec, parameters?: Record<string, JsonValue>): void {
    const cycles = findCycles(spec.nodes, spec.edges);
    let reserved = spec.nodes.length;
    for (const node of spec.nodes) {
        if (node.plugin !== 'builtin.route' || node.pluginVersion !== '2.0.0') continue;
        const values = scopedParameters(spec, node.id, parameters ?? {});
        const config = object(resolveFlowParameters(node.config, values));
        validateDispatch(config as unknown as import('../../contracts').DispatchConfig);
        if (cycles.loopNodes.has(node.id) || (config.maxIterations !== undefined && config.maxIterations !== 1)) {
            throw new Error('Structured route owns its rounds and cannot participate in a legacy back-edge loop');
        }
        if (Number.isSafeInteger(config.maxRounds) && Array.isArray(config.branches)) {
            reserved += Number(config.maxRounds) * (config.mode === 'exclusive' ? 1 : config.branches.length);
            if (object(config.revision).invocation) reserved += Math.max(0, Number(config.maxRounds) - 1);
        }
    }
    const limit = spec.maxNodes ?? spec.runPolicy?.maxNodes ?? 1000;
    if (reserved > limit) throw new Error(`Flow node limit exceeded by structured dispatch reservation: ${reserved}/${limit}`);
}

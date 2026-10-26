import {invocationLabels, targetLabels, type DagPluginCatalog, type DagRunSpec, type JsonValue, type InvocationIdentity} from '../contracts';
import type {TaskRunDefinition} from '../run-submission';
import {compileReferenceGraph} from './structured/references';
import {compileDispatchGraph} from './structured/graph';
import {compileControlGraph} from './control/graph';
import {validateDispatchCapacity} from './structured/limits';
import {prepareFlowParameters, resolveFlowParameters} from './parameters';
import {prepareFlowRuntimeInput} from './runtime-input';
import {createRunCatalog} from './run-catalog';
import {functionTemplateNodes} from './function-batch';
import {createSchedulerCollections, snapshotSchedulerCollections} from './scheduler-state';
import {validateVariableGraph} from './variables';

interface Options {
    sessionId: string; roundId: string; plugins: DagPluginCatalog; contextProgramVersion: '1' | '2';
    sessionContext?: {projectInstructions: string; skillInstructions: string; skillIndex: string};
}

/** Freeze the original aggregate root and empty scheduler checkpoint; no Task or workspace is created. */
export function prepareFlowCallTask(graph: DagRunSpec, parameters: Record<string, JsonValue> | undefined,
    options: Options): TaskRunDefinition {
    const spec = graph.templateVersion === 1 ? structuredClone(graph)
        : compileReferenceGraph(compileControlGraph(compileDispatchGraph(structuredClone(graph))));
    spec.input = prepareFlowRuntimeInput(spec.input);
    parameters = prepareFlowParameters(spec.parameterSchema, parameters, spec.inputGroups);
    validateDispatchCapacity(spec, parameters); validateVariableGraph(spec);
    const catalog = createRunCatalog(options.plugins, functionTemplateNodes(spec));
    const state = createSchedulerCollections(spec, undefined, routeEdges(spec));
    const checkpoint = snapshotSchedulerCollections(state, new Map(), new Set(), {
        controlTreeVersion: 1, invocationIdentityVersion: 1, contextProgramVersion: options.contextProgramVersion,
        spec, parameters, sessionContext: structuredClone(options.sessionContext), catalog: catalog.snapshot(), consumedTokens: 0, startedAt: 0,
        nodeDefaults: Object.entries(spec.nodeDefaults ?? {}).map(([id, value]) =>
            [id, parameters ? resolveFlowParameters(value, parameters) as Record<string, unknown> : value]),
        nodeConnections: Object.entries(spec.nodeConnections ?? {}),
    });
    return {kind: 'task', sessionId: options.sessionId, capabilities: [], task: {
        program: {kind: 'flow.aggregate', version: '1'}, input: {
            awaitingSchedule: true, dependencies: [], skipped: [], runTasks: [], initialScheduler: checkpoint,
            initialWorkspacePending: 1, initialWorkspaceResource: 1,
            run: {version: 1, goal: spec.goal ?? null, usage: {tokens: 0, startedAt: 0, elapsedMs: 0}}},
        labels: {kind: 'flow-root', roundId: options.roundId, ...targetLabels(spec.invocation?.target),
            ...invocationLabels(spec.invocation?.invocationId ? spec.invocation as InvocationIdentity : undefined)},
    }};
}
function routeEdges(spec: DagRunSpec): Set<string> {
    const ids = new Set<string>();
    for (const node of spec.nodes) {
        if (node.plugin !== 'builtin.route') continue;
        const config = node.config as {rules?: {edgeId?: string}[]; defaultEdgeId?: string};
        for (const rule of Array.isArray(config.rules) ? config.rules : [])
            if (typeof rule?.edgeId === 'string' && rule.edgeId.trim()) ids.add(rule.edgeId.trim());
        if (typeof config.defaultEdgeId === 'string' && config.defaultEdgeId.trim()) ids.add(config.defaultEdgeId.trim());
    }
    return ids;
}

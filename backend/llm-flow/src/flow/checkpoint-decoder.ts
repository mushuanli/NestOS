import { isFlowRuntimeInput } from './runtime-input';
import { flowInputDeclarationIssues, type FlowInputGroup, type FlowParameter } from '../contracts';
import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { isFlowSkipRecord } from './skip-state';
import { isRecord, isIdentity, strings, isGraphNode, isGraphEdge } from './graph-decoder';

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const enumValue = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);
const pairs = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value)
    && value.every(pair => Array.isArray(pair) && pair.length === 2 && isIdentity(pair[0]) && check(pair[1]));
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const graph = (value: unknown, depth = 0): boolean => depth <= 32 && isRecord(value) && Array.isArray(value.nodes) && value.nodes.every(isGraphNode)
    && Array.isArray(value.edges) && value.edges.every(isGraphEdge)
    && validGroups(value.inputGroups, value.parameterSchema)
    && optional(value.input, isFlowRuntimeInput)
    && optional(value.functionCalls, calls => isFunctionCalls(calls, depth + 1))
    && optional(value.parameterScopes, isParameterScopes);

/** Prepared plans and scheduler recovery share the same graph envelope validation. */
export function isDagRunSpec(value: unknown): value is import('../contracts').DagRunSpec { return graph(value); }

const fields: Record<string, (value: unknown) => boolean> = {
    invocationIdentityVersion: value => optional(value, value => value === 1),
    version: value => value === 1,
    nodes: value => Array.isArray(value) && value.every(isGraphNode),
    edges: value => Array.isArray(value) && value.every(isGraphEdge),
    spec: graph,
    instances: value => pairs(value, strings),
    edgeState: value => pairs(value, value => enumValue(value, ['active', 'inactive', 'pending'])),
    delegationDepth: value => pairs(value, finite),
    delegationGroups: value => pairs(value, isGroup),
    delegationGroupByChild: value => pairs(value, isIdentity),
    appliedPatches: value => pairs(value, isIdentity),
    nodeDefaults: value => pairs(value, isRecord),
    nodeConnections: value => pairs(value, isConnections),
    consumedTokens: finite, startedAt: finite,
    completed: strings, skipped: strings, detachedNodes: strings, completionOrder: strings, dispatchOrder: strings,
    skipRecords: value => optional(value, value => pairs(value, isFlowSkipRecord)),
    nodeGenerations: value => optional(value, value => pairs(value, finite)),
    appliedGraphRetries: value => optional(value, strings),
    parameters: value => optional(value, isRecord),
    sessionContext: value => optional(value, isContext),
    contextProgramVersion: value => optional(value, value => value === '1' || value === '2'),
    variables: value => optional(value, isVariables),
    catalog: value => optional(value, isCatalog),
};

/** Validate the persisted scheduler envelope before restoring collections or dispatching. */
export function decodeSchedulerCheckpoint(value: unknown): SchedulerCheckpoint | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new TypeError('Invalid Flow scheduler checkpoint: envelope');
    const invalid = Object.entries(fields).filter(([key, check]) => !check(value[key])).map(([key]) => key);
    if (invalid.length) throw new TypeError(`Invalid Flow scheduler checkpoint: ${invalid.join(', ')}`);
    return value as unknown as SchedulerCheckpoint;
}

function isGroup(value: unknown): boolean {
    return isRecord(value) && ['children', 'completed', 'succeeded'].every(key => strings(value[key]))
        && typeof value.detached === 'boolean' && finite(value.quorum) && optional(value.deadline, finite)
        && enumValue(value.policy, ['fail-fast', 'continue', 'retry'])
        && enumValue(value.waitMode, ['all', 'any', 'first-success', 'quorum'])
        && optional(value.remaining, value => value === 'continue' || value === 'cancel')
        && enumValue(value.resultOrder, ['declared', 'completion']);
}
function isContext(value: unknown): boolean {
    return isRecord(value) && ['projectInstructions', 'skillInstructions', 'skillIndex'].every(key => typeof value[key] === 'string');
}
function isVariables(value: unknown): boolean {
    return isRecord(value) && isRecord(value.initial) && isRecord(value.snapshots) && Array.isArray(value.commits)
        && value.commits.every(commit => isRecord(commit) && isIdentity(commit.taskId) && isIdentity(commit.nodeId)
            && typeof commit.scope === 'string' && isRecord(commit.updates));
}

function isConnections(value: unknown): boolean {
    return isRecord(value) && ['defaultConnection', 'fallbackConnectionId', 'runConnectionId'].every(key => optional(value[key], isIdentity))
        && optional(value.connections, value => Array.isArray(value) && value.every(slot =>
            isRecord(slot) && isIdentity(slot.name) && optional(slot.connectionId, isIdentity)));
}
function isCatalog(value: unknown): boolean {
    return isRecord(value) && pairs(value.manifests, value => value === null || isRecord(value))
        && pairs(value.schemas, value => value !== undefined) && optional(value.localSchemas, strings);
}

function isFunctionCalls(value: unknown, depth: number): boolean {
    return isRecord(value) && Object.entries(value).every(([id, template]) => isIdentity(id) && isRecord(template)
        && isIdentity(template.collector) && Number.isSafeInteger(template.maxConcurrency) && Number(template.maxConcurrency) > 0
        && graph(template.child, depth));
}
function isParameterScopes(value: unknown): boolean {
    return isRecord(value) && Object.values(value).every(scope => isRecord(scope)
        && typeof scope.parent === 'string' && optional(scope.source, isIdentity)
        && optional(scope.parameterSet, index => Number.isSafeInteger(index) && Number(index) >= 0)
        && isRecord(scope.defaults) && isRecord(scope.values) && optional(scope.schema, Array.isArray) && validGroups(scope.groups, scope.schema));
}

function validGroups(groups: unknown, schema: unknown): boolean {
    return groups === undefined || Array.isArray(groups) && Array.isArray(schema)
        && flowInputDeclarationIssues({parameters: schema as FlowParameter[], inputGroups: groups as FlowInputGroup[]}).length === 0;
}

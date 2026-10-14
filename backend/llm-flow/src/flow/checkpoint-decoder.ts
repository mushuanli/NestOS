import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { isRecord, isIdentity, strings, isGraphNode, isGraphEdge } from './graph-decoder';

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const enumValue = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);
const pairs = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value)
    && value.every(pair => Array.isArray(pair) && pair.length === 2 && isIdentity(pair[0]) && check(pair[1]));
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const graph = (value: unknown) => isRecord(value) && Array.isArray(value.nodes) && value.nodes.every(isGraphNode)
    && Array.isArray(value.edges) && value.edges.every(isGraphEdge);

const fields: Record<string, (value: unknown) => boolean> = {
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
    if (!isRecord(value) || value.version !== 1 || !graph(value)
        || !Object.entries(fields).every(([key, check]) => check(value[key]))) {
        throw new TypeError('Invalid Flow scheduler checkpoint');
    }
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
            isRecord(slot) && isIdentity(slot.name) && isIdentity(slot.connectionId)));
}
function isCatalog(value: unknown): boolean {
    return isRecord(value) && pairs(value.manifests, value => value === null || isRecord(value))
        && pairs(value.schemas, value => value !== undefined) && optional(value.localSchemas, strings);
}

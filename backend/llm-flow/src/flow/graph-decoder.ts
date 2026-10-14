import type { DagNodeDefinition, GraphEffect } from '../contracts';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
export const isIdentity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isIdentity);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);

export function isGraphNode(value: unknown): value is DagNodeDefinition {
    return isRecord(value) && ['id', 'plugin', 'pluginVersion'].every(key => isIdentity(value[key]))
        && typeof value.name === 'string' && isRecord(value.inputs) && Object.hasOwn(value, 'config')
        && optional(value.capabilities, strings) && optional(value.budget, value => isRecord(value)
            && Object.values(value).every(value => typeof value === 'number' && Number.isFinite(value)));
}

export function isGraphEdge(value: unknown): boolean {
    return isRecord(value) && ['id', 'from', 'to'].every(key => isIdentity(value[key]))
        && ['input', 'output'].every(key => optional(value[key], value => typeof value === 'string'))
        && optional(value.kind, value => value === 'control' || value === 'data')
        && optional(value.onFailure, value => value === 'fail' || value === 'skip' || value === 'continue');
}

function isEffect(value: unknown): value is GraphEffect {
    if (!isRecord(value)) return false;
    switch (value.type) {
        case 'activate-edge': case 'disable-edge': return isIdentity(value.edgeId);
        case 'cancel-tasks': return typeof value.reason === 'string' && Array.isArray(value.tasks)
            && value.tasks.every(task => isRecord(task) && isIdentity(task.nodeId) && isIdentity(task.taskId));
        case 'patch-graph': return isRecord(value.patch) && isIdentity(value.patch.idempotencyKey)
            && Array.isArray(value.patch.nodes) && value.patch.nodes.every(isGraphNode)
            && Array.isArray(value.patch.edges) && value.patch.edges.every(isGraphEdge);
        default: return false;
    }
}

/** Decode the whole batch before any graph effect can mutate live state. */
export function graphEffects(output: unknown): GraphEffect[] {
    if (!isRecord(output) || output.effects === undefined) return [];
    if (!Array.isArray(output.effects) || !output.effects.every(isEffect)) throw new TypeError('Invalid Flow graph effects');
    return output.effects;
}

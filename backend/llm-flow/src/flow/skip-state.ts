/** Why a node never ran. The vocabulary is generic; business meaning stays in Flow resources. */
export type FlowSkipReason = 'branch-not-selected' | 'upstream-skipped' | 'call-source-skipped' | 'delegation-cancelled';

export interface FlowSkipCause { nodeId?: string; edgeId?: string }

/** Recorded once per skipped node so propagation cannot overwrite the deciding cause. */
export interface FlowSkipRecord { reason: FlowSkipReason; iteration: number; cause?: FlowSkipCause }

export type FlowSkipRecords = Map<string, FlowSkipRecord>;

export const FLOW_SKIP_REASONS: readonly FlowSkipReason[] = [
    'branch-not-selected', 'upstream-skipped', 'call-source-skipped', 'delegation-cancelled',
];

export function recordFlowSkip(records: FlowSkipRecords, nodeId: string, record: FlowSkipRecord): void {
    if (!records.has(nodeId)) records.set(nodeId, record);
}

/** Activation and graph invalidation both clear the reason with the skip flag. */
export function clearFlowSkip(records: FlowSkipRecords, nodeId: string): void {
    records.delete(nodeId);
}

/** Sorted pairs keep a restored checkpoint byte-stable across saves. */
export function serializeFlowSkips(records: FlowSkipRecords): [string, FlowSkipRecord][] {
    return [...records].sort(([left], [right]) => left.localeCompare(right));
}

export function restoreFlowSkips(value: [string, FlowSkipRecord][] | undefined): FlowSkipRecords {
    return new Map(value ?? []);
}

export function isFlowSkipRecord(value: unknown): value is FlowSkipRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<FlowSkipRecord>;
    return typeof record.reason === 'string' && FLOW_SKIP_REASONS.includes(record.reason as FlowSkipReason)
        && Number.isSafeInteger(record.iteration) && (record.iteration as number) > 0
        && validCause(record.cause);
}

function validCause(value: unknown): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const cause = value as Record<string, unknown>;
    return [cause.nodeId, cause.edgeId].every(item => item === undefined || typeof item === 'string');
}

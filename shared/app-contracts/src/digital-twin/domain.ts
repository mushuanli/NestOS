import type { TwinUserIdentity } from './identity';
export const TWIN_KINDS = ['fact', 'preference', 'role', 'relationship', 'project', 'event', 'decision',
    'goal', 'commitment', 'question', 'experience', 'constraint'] as const;
export type TwinMemoryKind = typeof TWIN_KINDS[number];
export interface TwinRelation { predicate: string; target: string; targetKind: 'person' | 'organization' | 'project'; }
export interface TwinMemoryData {
    originSourceId?: string;
    relation?: TwinRelation; entityScope?: string; projectId?: string;
    content: string; kind: TwinMemoryKind; subject: string; subjectId: string; project: string;
    state: 'candidate' | 'active' | 'rejected' | 'disputed';
    eventTime: string; recordedAt: number;
    evidenceIds: string[]; sourceId: string; sourceHash: string; sourceIncarnation: string;
    quote: string; independent: boolean;
    goalStatus: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
    successCondition: string; deadline: string; executionRefs: Array<{ sessionId: string; taskId: string }>;
}
export interface TwinSourceSpec { kind: 'file' | 'session' | 'harness-session'; target: string; label: string; }
export interface TwinDiscoveredSource extends TwinSourceSpec {
    location?: 'local' | 'remote'; directoryPath?: string;
    projectId: string; projectName?: string; path?: string; sessionId?: string; profileId?: string; version?: string;
}
export interface TwinSourceCatalog {
    resources: TwinDiscoveredSource[]; projects: string[]; completeScopes: string[]; errors: string[];
}
export interface TwinSourceData extends TwinSourceSpec {
    retained?: boolean; managed?: boolean; resource?: TwinDiscoveredSource; observedVersion?: string;
    connectionId: string; connectionFingerprint: string; enabled: boolean; incarnation: string; nativeIdentity: string;
    hash: string; checkedAt: number; analyzedHash: string; offset: number;
    status: 'available' | 'changed' | 'deleted' | 'inaccessible';
    characters: number;
}
export interface TwinSourceContent { text: string; hash: string; nativeIdentity: string; }
export interface TwinSourceReader {
    read(spec: TwinSourceSpec): Promise<TwinSourceContent>;
    discover?(): Promise<TwinSourceCatalog>;
    probe?(spec: TwinSourceSpec): Promise<string>;
    sessions(): Promise<Array<{ id: string; title: string }>>;
}
export interface TwinSettings extends TwinUserIdentity {
    monthlyTokenLimit?: number | null;
    budgetUnlimited?: boolean;
    tokenLimit: number; reservedTokens: number; spentTokens: number; paused: boolean;
    useEnabled: boolean; connectionId?: string; globalExclude?: string[];
}
export interface TwinGrantData { sessionId: string; agentId: string; connectionId: string; enabled: boolean; project: string; connectionFingerprint?: string; }
export interface TwinAnalysisJob extends TwinUserIdentity {
    meterPeriod?: string;
    errorDetail?: string; actualTokens?: number;
    createdAt?: number; startedAt?: number; finishedAt?: number;
    requestStartedAt?: number; responseReceivedAt?: number; responseCompletedAt?: number;
    sourceId: string; sourceRevision: string; sourceHash: string; offset: number; start?: number; end: number;
    connectionId: string; sessionId: string; taskId: string; epoch: number;
    reservedTokens: number; state: 'queued' | 'running' | 'committed' | 'failed' | 'cancelled'; error: string;
    addedMemories?: number; cancelConfirmed?: boolean; cleaned?: boolean; cleanupError?: string;
    scanScope?: TwinScanScope;
    checkpointId?: string; checkpointRevision?: string | null;
}
export interface TwinCandidate { relation?: TwinRelation; content: string; kind: TwinMemoryKind; subject: string; project: string; eventTime: string; quote: string; }

export function memoryData(input: Partial<TwinMemoryData>): TwinMemoryData {
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4000) throw new Error('TWIN_INVALID_CONTENT');
    if (!TWIN_KINDS.includes(input.kind ?? 'fact')) throw new Error('TWIN_INVALID_KIND');
    for (const key of ['subject', 'project', 'eventTime', 'successCondition', 'deadline'] as const) {
        if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 1000)) throw new Error('TWIN_INVALID_CONTENT');
    }
    if (input.goalStatus && !['draft', 'active', 'paused', 'completed', 'cancelled'].includes(input.goalStatus)) throw new Error('TWIN_INVALID_GOAL_STATUS');
    const subject = input.subject?.trim() || 'self';
    const relation = validateRelation(input.relation);
    return { originSourceId: input.originSourceId, ...(relation ? { relation } : {}), entityScope: input.entityScope, projectId: input.projectId, content: input.content.trim(), kind: input.kind ?? 'fact', subject, subjectId: input.subjectId ?? (subject === 'self' ? 'self' : `user:${subject}`),
        project: input.project?.trim() || '', state: input.state ?? 'active', eventTime: input.eventTime ?? '', recordedAt: input.recordedAt ?? Date.now(),
        evidenceIds: input.evidenceIds ?? [], sourceId: input.sourceId ?? '', sourceHash: input.sourceHash ?? '',
        sourceIncarnation: input.sourceIncarnation ?? '', quote: input.quote ?? '', independent: input.independent ?? true,
        goalStatus: input.goalStatus ?? 'draft', successCondition: input.successCondition ?? '', deadline: input.deadline ?? '', executionRefs: input.executionRefs ?? [] };
}

export function validateRelation(value: unknown): TwinRelation | undefined {
    if (value === undefined || value === null) return undefined;
    const relation = value as TwinRelation;
    if (typeof relation.predicate !== 'string' || !relation.predicate.trim() || relation.predicate.length > 100
        || typeof relation.target !== 'string' || !relation.target.trim() || relation.target.length > 200
        || !['person', 'organization', 'project'].includes(relation.targetKind)) throw new Error('TWIN_INVALID_RELATION');
    return { predicate: relation.predicate.trim(), target: relation.target.trim(), targetKind: relation.targetKind };
}

export interface TwinScanScope { runId: string; planId: string; planRevision: string; sourceId: string; fence: number; kinds: TwinMemoryKind[]; focus?: string; }

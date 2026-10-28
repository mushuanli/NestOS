/** Shared application capabilities; implementations belong to backend/app-core. */
import type * as ContextContracts from '@itookit/llm-context';
import type { ContextPlan } from '@itookit/llm-context';
import type * as AppContracts from '../index';
import type { TwinMemoryKind, TwinAnalysisJob, TwinSourceData, TwinMemoryData, TwinSettings, TwinSourceSpec, TwinSelectionTarget, TwinSelectionType } from '../index';

export interface TwinScanRuleInput extends TwinScanRules {
    trigger?: 'manual' | 'interval' | 'changes';
    autoConfirm?: boolean;
    runTokenLimit?: number | null;
    focus?: string;
    name: string;
    intervalMinutes: number;
    enabled: boolean;
    kinds?: TwinMemoryKind[];
}

export interface TwinScanRules {
    include: string[];
    exclude: string[];
    selection?: boolean;
}

export interface TwinScanPlan extends TwinScanPlanInput {
    connectionFingerprint: string;
    createdAt: number;
    updatedAt: number;
}

export interface TwinScanPlanInput {
    runTokenLimit?: number;
    rules?: TwinScanRules;
    autoConfirm?: boolean;
    focus?: string;
    name: string;
    sourceIds: string[];
    connectionId: string;
    kinds: TwinMemoryKind[];
    mode: 'analyze' | 'reconcile';
    trigger: 'manual' | 'interval' | 'changes';
    intervalMinutes: number;
    tokenLimit: number;
    enabled: boolean;
}

export interface TwinGraphNode {
    id: string;
    kind: TwinEntityKind;
    name: string;
    memoryIds: string[];
    aliases: string[];
}

export type TwinEntityKind = 'person' | 'organization' | 'project' | 'event' | 'goal';

export interface TwinDataRecord<T> {
    id: string;
    revision: string;
    data: T;
}

export interface DigitalTwinService {
    diagnostics(): {
        initialization: string;
    };
    onChange(listener: () => void): () => void;
    scanOnce(): Promise<void>;
    snapshot(progress?: (stage: string) => void): Promise<{
        prompt: string;
        graph: TwinGraph;
        cleanupError: string;
        pendingCleanup: TwinCleanup[];
        sources: {
            observedAt: number;
            id: string;
            revision: string;
            data: TwinSourceData;
        }[];
        memories: {
            retained: boolean;
            supported: boolean;
            id: string;
            revision: string;
            data: TwinMemoryData;
        }[];
        settings: TwinDataRecord<TwinSettings>;
        jobs: TwinDataRecord<TwinAnalysisJob>[];
        uses: TwinDataRecord<TwinUseRecord>[];
        sessions: {
            id: string;
            title: string;
        }[];
        scans: {
            discovery: {
                errors: string[];
            };
            plans: TwinDataRecord<TwinScanPlan>[];
            runs: TwinDataRecord<TwinScanRun>[];
            schedules: {
                planId: string;
                nextAt: number;
            }[];
            worker: {
                ownerHost: string;
                leaseUntil: number;
                host: string;
                online: boolean;
                error: string;
            };
        };
    }>;
    mergePeople(from: string, to: string): Promise<void>;
    previewSource(spec: TwinSourceSpec): Promise<AppContracts.TwinSourceContent>;
    addSource(spec: TwinSourceSpec, connectionId: string): Promise<string>;
    setSourceEnabled(id: string, revision: string, enabled: boolean): Promise<void>;
    removeSource(id: string, revision: string): Promise<void>;
    analyze(id: string): Promise<void>;
    cancelAnalysis(id: string): Promise<void>;
    selectionInfo(target: TwinSelectionTarget): Promise<{
        sources: {
            observedAt: number;
            id: string;
            revision: string;
            data: TwinSourceData;
        }[];
        plan: TwinDataRecord<TwinScanPlan> | undefined;
        included: boolean;
        memories: {
            retained: boolean;
            supported: boolean;
            id: string;
            revision: string;
            data: TwinMemoryData;
        }[];
        runs: TwinDataRecord<TwinScanRun>[];
        jobs: TwinDataRecord<TwinAnalysisJob>[];
        settings: TwinDataRecord<TwinSettings>;
        nextScanAt: number;
        ignored: boolean;
        worker: {
            ownerHost: string;
            leaseUntil: number;
            host: string;
            online: boolean;
            error: string;
        };
        discoveryErrors: string[];
    }>;
    selectSource(target: TwinSelectionTarget, type: TwinSelectionType): Promise<void>;
    removeSelection(target: TwinSelectionTarget): Promise<void>;
    previewScanRule(rules: TwinScanRules): Promise<{
        resources: AppContracts.TwinDiscoveredSource[];
        excluded: AppContracts.TwinDiscoveredSource[];
        errors: string[];
    }>;
    saveScanRule(id: string | null, revision: string | null, input: TwinScanRuleInput): Promise<string>;
    saveScanPlan(id: string | null, revision: string | null, input: TwinScanPlanInput): Promise<string>;
    setScanPlanEnabled(id: string, revision: string, enabled: boolean): Promise<void>;
    removeScanPlan(id: string, revision: string): Promise<void>;
    runScanPlan(id: string): Promise<string>;
    waitScanRun(id: string): Promise<void>;
    cancelScanRun(id: string): Promise<void>;
    addMemory(input: Partial<TwinMemoryData>): Promise<string>;
    review(id: string, revision: string, action: 'confirm' | 'reject' | 'dispute' | 'correct', patch?: Partial<TwinMemoryData>): Promise<void>;
    linkExecution(id: string, revision: string, reference: {
        sessionId: string;
        taskId: string;
    }): Promise<void>;
    suppress(id: string, revision: string): Promise<void>;
    forgetPreview(id: string): Promise<string[]>;
    forgetScopePreview(scope: {
        subjectId?: string;
        project?: string;
    }): Promise<{
        ids: string[];
        sessions: string[];
    }>;
    forgetScope(scope: {
        subjectId?: string;
        project?: string;
    }, deleteSessions?: string[]): Promise<{
        retainedSessions: string[];
    }>;
    forget(id: string, deleteSessions?: string[]): Promise<{
        retainedSessions: string[];
    }>;
    getSettings(): Promise<TwinDataRecord<TwinSettings>>;
    configure(patch: Partial<Pick<TwinSettings, 'tokenLimit' | 'budgetUnlimited' | 'paused' | 'useEnabled' | 'connectionId' | 'globalExclude' | 'userName' | 'userAliases'>>, revision: string): Promise<void>;
    retrieve(plan: ContextPlan, agentId: string, sessionId: string): Promise<ContextContracts.RetrievedMemoryEntry[]>;
}

export interface TwinScanRun {
    runTokenLimit?: number;
    budgetUnlimited?: boolean;
    errorDetail?: string;
    rules?: TwinScanRules;
    autoConfirm?: boolean;
    focus?: string;
    planId: string;
    planRevision: string;
    name: string;
    sourceIds: string[];
    completedSourceIds: string[];
    connectionId: string;
    connectionFingerprint: string;
    kinds: TwinMemoryKind[];
    mode: 'analyze' | 'reconcile';
    state: TwinScanState;
    trigger: 'manual' | 'interval' | 'changes';
    singleBatch: boolean;
    tokenLimit: number;
    reservedTokens: number;
    spentTokens: number;
    createdAt: number;
    startedAt: number;
    finishedAt: number;
    owner: string;
    fence: number;
    error: string;
}

export type TwinScanState = 'queued' | 'running' | 'succeeded' | 'paused' | 'failed' | 'cancelled' | 'interrupted';

export interface TwinUseRecord {
    sessionId: string;
    taskId: string;
    agentId: string;
    connectionId: string;
    grantRevision: string;
    memoryRefs: Array<{
        id: string;
        revision: string;
    }>;
    usedAt: number;
}

export interface TwinCleanup {
    cursors: Record<string, string | null>;
    recordOffset: number;
    operationId: string;
    records: TwinRecordRef[];
    state: 'invalidated' | 'cleaning' | 'completed';
    forgetEpoch: number;
}

export interface TwinRecordRef {
    family: TwinRecordFamily;
    id: string;
}

export type TwinRecordFamily = 'memory' | 'evidence' | 'support' | 'derivation' | 'review' | 'entity' | 'relation' | 'goal' | 'work-item' | 'binding' | 'source' | 'checkpoint' | 'grant' | 'suppression' | 'projection' | 'settings' | 'job' | 'usage' | 'scan-plan' | 'scan-run' | 'scan-checkpoint';

export interface TwinGraph {
    nodes: TwinGraphNode[];
    edges: TwinGraphEdge[];
}

export interface TwinGraphEdge {
    id: string;
    from: string;
    to: string;
    predicate: string;
    memoryIds: string[];
}

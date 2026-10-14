import type { DagRunSpec, DagNodeDefinition, DagEdgeDefinition, JsonValue } from '../contracts';
import type { DelegationGroup, EdgeState } from './delegation-runtime';

/** Scheduler state saved at an explicit human-interaction boundary. */
export interface SchedulerCheckpoint {
    /** Frozen at Run creation; missing on legacy Runs means v1. */
    contextProgramVersion?: '1' | '2';
    version: 1;
    variables?: import('./variables').VariableCheckpoint;
    /** Absent on legacy checkpoints; new Runs reject changed host contracts on resume. */
    catalog?: import('./run-catalog').RunCatalogSnapshot;
    spec: DagRunSpec;
    parameters?: Record<string, JsonValue>;
    sessionContext?: { projectInstructions: string; skillInstructions: string; skillIndex: string };
    instances: [string, string[]][];
    completed: string[];
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    edgeState: [string, EdgeState][];
    delegationDepth: [string, number][];
    delegationGroups: [string, Omit<DelegationGroup, 'children' | 'completed' | 'succeeded'> & {
        children: string[]; completed: string[]; succeeded: string[];
    }][];
    delegationGroupByChild: [string, string][];
    skipped: string[];
    detachedNodes: string[];
    appliedPatches: [string, string][];
    /** Retry receipts committed with graph state before acknowledging the intent queue. */
    appliedGraphRetries?: string[];
    nodeDefaults: [string, Record<string, unknown>][];
    nodeConnections: [string, NonNullable<DagRunSpec['nodeConnections']>[string]][];
    consumedTokens: number;
    startedAt: number;
    completionOrder: string[];
    dispatchOrder: string[];
    /** 每节点的提交代数；图级 retry 后递增，使重算实例不命中旧提交的 requestId。 */
    nodeGenerations?: [string, number][];
}

import type {KanbanPrincipal, KanbanExternalReference} from './configuration';
import type {KanbanEstimate} from './contracts';
export interface KanbanArtifactRef {name: string; ref: string; sha256: string; bytes: number}
export interface KanbanWorkDefinition {
    expectedRevision?: number; workType?:string; externalRefs?:KanbanExternalReference[];
    id: string; title: string; responsibility: string; acceptance: string; assignee: KanbanPrincipal;
    dependsOn: string[]; inputs?: Record<string, {fromItemId: string; output: string}>; outputs?: string[];
}
export interface KanbanWorkPlan {
    schema: 'kanban.plan/1'; id: string; revision: number; decisionId?: string; rootItemId?: string;
    sealed: boolean; items: KanbanWorkDefinition[];
}
export interface KanbanPublishedPlan extends Omit<KanbanWorkPlan, 'items'> {itemIds: string[]; definitions: Record<string, {digest: string; inputs: KanbanWorkDefinition['inputs']; outputs: string[]}>}
export interface KanbanDispatch {
    id: string; itemId: string; itemRevision: number; planId: string; planRevision: number;
    principal: KanbanPrincipal; definitionDigest: string; attempt: number; fence: string; preparedAt: number;
    outcome: 'prepared' | 'running' | 'unknown' | 'succeeded' | 'failed' | 'cancelled' | 'accepted' | 'rejected';
    inputs: Record<string, KanbanArtifactRef>; outputs?: KanbanArtifactRef[]; code?: string;
}
export interface KanbanWorkflowState {plans: Record<string, KanbanPublishedPlan>; dispatches: Record<string, KanbanDispatch>; ready: string[]; completedPlans: string[]}
export type KanbanWorkflowCommand =
    | {type: 'publish-plan'; plan: KanbanWorkPlan}
    | {type: 'prepare-dispatch'; itemId: string; dispatchId: string; estimate?: KanbanEstimate}
    | {type: 'observe-execution'; dispatchId: string; fence: string; outcome: 'running' | 'unknown' | 'succeeded' | 'failed' | 'cancelled'; outputs?: KanbanArtifactRef[]; code?: string}
    | {type: 'accept-execution'; dispatchId: string; accept: boolean};

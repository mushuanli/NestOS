import type {KanbanExternalReference, KanbanPrincipal} from './configuration';

export interface KanbanAutomationSettings {
    enabled: boolean; planner: KanbanExternalReference; executor: KanbanExternalReference;
    coordinator: KanbanPrincipal; worker: KanbanPrincipal; autoAccept: boolean;
}
export interface KanbanAutomationTarget {reference: KanbanExternalReference; label: string}
export interface KanbanAutomationCatalog {
    targets: KanbanAutomationTarget[]; coordinator: KanbanPrincipal; worker: KanbanPrincipal;
}
export interface KanbanAnalysisStatus {
    itemId: string; state: 'analyzing' | 'ready' | 'clarification' | 'failed' | 'unknown';
    reason?: string; code?: string; dependencies?: string[];
}
export function sameAutomationBinding(left?: KanbanAutomationSettings, right?: KanbanAutomationSettings): boolean {
    const signature = (value?: KanbanAutomationSettings) => JSON.stringify([value?.planner?.system, value?.planner?.id, value?.planner?.revision,
        value?.executor?.system, value?.executor?.id, value?.executor?.revision, value?.coordinator?.kind, value?.coordinator?.id,
        value?.worker?.kind, value?.worker?.id, value?.autoAccept]);
    return signature(left) === signature(right);
}

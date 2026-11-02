import type {KanbanAutomationCatalog, KanbanExternalReference} from '@itookit/kanban/contracts';
import type {TargetRef} from '@itookit/llm-flow/contracts';
import type {RootTargetCatalog} from '@itookit/llm-session/contracts';
import {requireValue} from './validation';
export const coordinator = {kind: 'service' as const, id: 'kanban-planner'};
export const worker = {kind: 'service' as const, id: 'kanban-worker'};
export function automationCatalog(catalog: RootTargetCatalog): KanbanAutomationCatalog {
    return {coordinator, worker, targets: catalog.entries.map(entry => ({label: entry.name,
        reference: {system: 'nestos-published-' + entry.target.kind, id: entry.target.id,
            revision: JSON.stringify([entry.target.version, entry.target.digest])}}))};
}
export function automationTarget(reference: KanbanExternalReference, catalog: RootTargetCatalog): TargetRef {
    const index = automationCatalog(catalog).targets.findIndex(({reference: candidate}) => candidate.system === reference.system && candidate.id === reference.id && candidate.revision === reference.revision);
    requireValue(index >= 0, 'AUTOMATION_TARGET_CHANGED');
    return structuredClone(catalog.entries[index].target);
}
export function assertAutomationPrincipals(settings: import('@itookit/kanban/contracts').KanbanAutomationSettings): void {
    requireValue(settings?.coordinator?.kind === coordinator.kind && settings.coordinator.id === coordinator.id
        && settings?.worker?.kind === worker.kind && settings.worker.id === worker.id, 'AUTOMATION_PRINCIPAL_MISMATCH');
}

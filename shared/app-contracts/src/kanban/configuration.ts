import type {KanbanItem} from './contracts';

export interface KanbanPrincipal {kind: 'agent' | 'human' | 'service'; id: string}
export interface KanbanMember extends KanbanPrincipal {
    responsibility: string; roles?: Array<'worker' | 'reviewer' | 'coordinator'>;
}
export interface KanbanWorkType {id: string; label: string; rank: number; executable: boolean}
export interface KanbanColumn {id: string; label: string; states: KanbanItem['status'][]}
export interface KanbanNotificationPolicy {rules?: Record<string, 'info' | 'error' | 'none'>}
export const DEFAULT_KANBAN_WORK_TYPES: readonly KanbanWorkType[] = [
    {id: 'initiative', label: 'Goal', rank: 0, executable: false},
    {id: 'feature', label: 'Group', rank: 1, executable: false},
    {id: 'task', label: 'Action', rank: 2, executable: true},
];

export interface KanbanExternalReference {system: string; id: string; revision?: string}

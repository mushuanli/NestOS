import type {KanbanExternalReference} from '@itookit/kanban/contracts';
export const KANBAN_EXECUTION_SESSION = 'nestos-execution-session';
export function executionSessionReference(sessionId: string, bindingId: string): KanbanExternalReference {
    return {system: KANBAN_EXECUTION_SESSION, id: sessionId, revision: bindingId};
}

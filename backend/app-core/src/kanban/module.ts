import {createKanbanActivityModule, type KanbanActivityModuleOptions} from '@itookit/kanban/activity';
import {KanbanError} from '@itookit/kanban';
import type {KanbanNotifications} from './notifications';
import {projectKanbanEvents} from './notifications';
import {createKanbanExecutionBridge, type KanbanExecutionBridgeOptions} from '@itookit/kanban/execution';
import {KANBAN_EXECUTION_SESSION, executionSessionReference} from '@itookit/app-contracts';

export interface NestOSKanbanOptions extends Omit<KanbanActivityModuleOptions, 'referenceSystem' | 'onCommitted'> {notifications?: KanbanNotifications}

/** NestOS supplies its resource namespace, authorized catalog and system event projection. */
export function createNestOSKanban(options: NestOSKanbanOptions) {
    if ((!options.actor.kind || options.actor.kind === 'agent') && (!options.actor.sessionId || !options.actor.taskId)) throw new KanbanError('INVALID_ID');
    const {notifications, ...core} = options;
    return createKanbanActivityModule({...core, referenceSystem: KANBAN_EXECUTION_SESSION,
        onCommitted: notifications ? (boardId, service, now) => projectKanbanEvents(notifications, service, boardId, now) : undefined,
    });
}

export function createNestOSKanbanExecutionBridge(options: KanbanExecutionBridgeOptions) {
    return createKanbanExecutionBridge({...options, executionReference: executionSessionReference});
}

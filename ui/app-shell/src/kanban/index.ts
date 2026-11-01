import {KanbanWorkbench as IndependentWorkbench} from '@itookit/kanban/ui';
import type {KanbanUIOptions} from '@itookit/kanban/ui';
import {executionSessionReference} from '@itookit/app-contracts';
import {VFS_DOM_EVENTS} from '@itookit/vfs-ui';
import {createWorkspaceModule} from '../workspaces/module';
import {kanbanPresentation} from './host';
type Options = Omit<KanbanUIOptions, 'presentation'>;

/** NestOS supplies presentation, resource navigation and its execution namespace. */
export class KanbanWorkbench extends IndependentWorkbench {
    constructor(options: Options) {
        super({...options, presentation: kanbanPresentation, executionReference: executionSessionReference,
            activated: () => options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}))});
    }
}
export function createKanbanWorkspace(options: Options) {return createWorkspaceModule(new KanbanWorkbench(options));}

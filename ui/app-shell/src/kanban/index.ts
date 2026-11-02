import {createWorkspaceModule} from '../workspaces/module';
import {KanbanWindowWorkbench, type KanbanWorkspaceOptions} from './windows';

export function createKanbanWorkspace(options: KanbanWorkspaceOptions) {return createWorkspaceModule(new KanbanWindowWorkbench(options));}

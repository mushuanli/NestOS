import type { WorkspaceConfig } from '@itookit/app-shell';
import {
    WS_SETTINGS, WS_WORKBENCH, WS_TOOLBOX, WS_TWIN, WS_AGENTS, WS_NOTES,
    WS_EMAILS, WS_PRIVATE, WS_SKILLS, WS_FLOWS,
    WS_HOME,
} from '@itookit/app-shell';

export const WORKSPACES: WorkspaceConfig[] = [
    WS_SETTINGS,
    WS_TOOLBOX,
    WS_TWIN,
    WS_HOME,
    WS_WORKBENCH,
    WS_EMAILS,
    WS_PRIVATE,
    WS_NOTES,
    WS_SKILLS,
    WS_FLOWS,
    { ...WS_AGENTS, mentionScope: ['agents', 'notes', 'projects', 'home'] },
];

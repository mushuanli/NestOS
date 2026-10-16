import type { WorkspaceConfig } from '@itookit/app-shell';
import {
    WS_SETTINGS, WS_CHAT, WS_TOOLBOX, WS_TWIN, WS_AGENTS, WS_MINDS,
    WS_EMAILS, WS_PRIVATE, WS_SKILLS, WS_FLOWS,
    WS_HOME,
} from '@itookit/app-shell';

export const WORKSPACES: WorkspaceConfig[] = [
    WS_SETTINGS,
    WS_TOOLBOX,
    WS_TWIN,
    WS_HOME,
    WS_CHAT,
    WS_EMAILS,
    WS_PRIVATE,
    WS_MINDS,
    WS_SKILLS,
    WS_FLOWS,
    { ...WS_AGENTS, mentionScope: ['agents', 'minds', 'projects', 'home'] },
];

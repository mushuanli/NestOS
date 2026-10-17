import {
    WS_SETTINGS, WS_CHAT, WS_TOOLBOX, WS_TWIN, WS_AGENTS, WS_MINDS,
    WS_EMAILS, WS_PRIVATE, WS_SKILLS, WS_FLOWS,
} from '@itookit/app-shell/workspaces';
import type { WorkspaceConfig } from '@itookit/app-shell';

export const ROUTE_ALIASES = {home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace'};

export const WORKSPACES: WorkspaceConfig[] = [
    WS_SETTINGS,
    WS_TOOLBOX,
    WS_TWIN,
    // Extend agents mentionScope to cover all reachable content modules
    { ...WS_AGENTS, mentionScope: ['agents', 'minds', 'projects'] },
    WS_MINDS,
    WS_EMAILS,
    WS_PRIVATE,
    WS_SKILLS,
    WS_FLOWS,
    WS_CHAT,
];

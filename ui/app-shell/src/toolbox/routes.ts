import { TOOLBOX_KINDS, toolboxPath, type ToolboxKind } from '@itookit/app-contracts';
export { TOOLBOX_KINDS, toolboxPath, toolboxKind, toolboxSourcePath, type ToolboxKind } from '@itookit/app-contracts';
export const TOOLBOX_FILTERS = ['all', 'agents', 'flows', 'skills', 'prompts', 'tools', 'mcp', 'models'] as const;
export type ToolboxFilter = typeof TOOLBOX_FILTERS[number];
export function toolboxFilter(kind: ToolboxKind): ToolboxFilter { return kind === 'providers' || kind === 'connections' ? 'models' : kind; }
/** Canonical paths preserve the original source path and never depend on the current filter. */
export function legacyToolboxRoute(target: string, resource?: string): { kind: ToolboxKind; path?: string } | undefined {
    const kind = TOOLBOX_KINDS.find(kind => [kind, { prompts: 'prompts-workspace', agents: 'agent-workspace', skills: 'skills-workspace', flows: 'flows-workspace', mcp: 'mcp-workspace', tools: 'tools-workspace', providers: 'providers-workspace', connections: 'connections-workspace' }[kind]].includes(target));
    return kind ? { kind, path: resource ? toolboxPath(kind, resource) : undefined } : undefined;
}

/** Settings page aliases remain valid after their configuration moves into the toolbox. */
export function toolboxSettingsRoute(resource?: string, anchor?: string): string | undefined {
    const kind = ({ 'system-prompts': 'prompts', '/System Prompts': 'prompts', providers: 'providers', connections: 'connections', 'mcp-servers': 'mcp',
        '/LLM Providers': 'providers', '/LLM 连接': 'connections', '/MCP Servers': 'mcp' } as Record<string, ToolboxKind>)[resource ?? ''];
    if (!kind) return undefined;
    const id = kind === 'connections' && anchor?.startsWith('conn:') ? anchor.slice(5) : anchor;
    return toolboxPath(kind, id ? '/' + encodeURIComponent(id) : '/');
}

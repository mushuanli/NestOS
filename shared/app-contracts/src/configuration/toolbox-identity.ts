export const TOOLBOX_KINDS = ['agents', 'flows', 'skills', 'prompts', 'tools', 'mcp', 'providers', 'connections'] as const;
export type ToolboxKind = typeof TOOLBOX_KINDS[number];
export function toolboxKind(path: string): ToolboxKind | undefined {
    return TOOLBOX_KINDS.find(kind => path === '/' + kind || path.startsWith('/' + kind + '/'));
}
export function toolboxSourcePath(path: string): string {
    const kind = toolboxKind(path); return kind ? path.slice(kind.length + 1) || '/' : path;
}
export function toolboxPath(kind: ToolboxKind, path = '/'): string {
    return '/' + kind + (path === '/' ? '' : path.startsWith('/') ? path : '/' + path);
}

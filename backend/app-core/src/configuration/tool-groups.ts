import { TOOLBOX_ICONS, t } from '@itookit/common';
import type { ToolboxInventory, ToolboxTool } from '@itookit/app-contracts/services';

type Category = 'files' | 'web' | 'memory' | 'tasks' | 'terminal' | 'collaboration' | 'extensions';
const categories: Record<string, Category> = {
    read: 'files', write: 'files', edit: 'files', glob: 'files', grep: 'files',
    websearch: 'web', webfetch: 'web', bash: 'terminal', shellsession: 'terminal', ttywrite: 'terminal', ttyclose: 'terminal',
    agent: 'collaboration', sendmessage: 'collaboration', askuserquestion: 'collaboration', askuser: 'collaboration',
    enterplanmode: 'collaboration', exitplanmode: 'collaboration',
};
function toolDrawerId(tool: ToolboxTool): string {
    if (tool.serverId) return '/tool-groups/mcp-' + encodeURIComponent(tool.serverId);
    const name = tool.id.slice('builtin:'.length).toLowerCase().replace(/[^a-z0-9]/g, '');
    const category = name.startsWith('memory') ? 'memory' : name.startsWith('task') || name.endsWith('task') ? 'tasks' : categories[name] ?? 'extensions';
    return '/tool-groups/' + category;
}
/** Plain grouping data for the application catalog, independent of rendering. */
export function defaultToolDrawers(inventory: ToolboxInventory): import('@itookit/app-contracts').Drawer[] {
    const groups = new Map<string, import('@itookit/app-contracts').Drawer>();
    for (const tool of inventory.tools.values()) {
        const id = toolDrawerId(tool), category = id.slice('/tool-groups/'.length) as Category;
        const group = groups.get(id) ?? { id, kind: 'tools', name: tool.serverId ? 'MCP · ' + tool.source : t(`toolbox.category.${category}`),
            icon: tool.serverId ? TOOLBOX_ICONS.mcp : TOOLBOX_ICONS[category], paths: [] };
        group.paths.push('/tools/' + encodeURIComponent(tool.id)); groups.set(id, group);
    }
    return [...groups.values()];
}

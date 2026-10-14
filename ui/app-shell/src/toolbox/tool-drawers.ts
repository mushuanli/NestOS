import { TOOLBOX_ICONS, t } from '@itookit/common';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import type { ToolboxInventory, ToolboxTool } from '@itookit/app-contracts/services';

type Category = 'files' | 'web' | 'memory' | 'tasks' | 'terminal' | 'collaboration' | 'extensions';
const categories: Record<string, Category> = {
    read: 'files', write: 'files', edit: 'files', glob: 'files', grep: 'files',
    websearch: 'web', webfetch: 'web', bash: 'terminal', shellsession: 'terminal', ttywrite: 'terminal', ttyclose: 'terminal',
    agent: 'collaboration', sendmessage: 'collaboration', askuserquestion: 'collaboration', askuser: 'collaboration',
    enterplanmode: 'collaboration', exitplanmode: 'collaboration',
};
export function toolDrawerId(tool: ToolboxTool): string {
    if (tool.serverId) return '/tool-groups/mcp-' + encodeURIComponent(tool.serverId);
    const name = tool.id.slice('builtin:'.length).toLowerCase().replace(/[^a-z0-9]/g, '');
    const category = name.startsWith('memory') ? 'memory' : name.startsWith('task') || name.endsWith('task') ? 'tasks' : categories[name] ?? 'extensions';
    return '/tool-groups/' + category;
}
export function toolDrawerPaths(id: string, inventory: ToolboxInventory): string[] {
    return [...inventory.tools.values()].filter(tool => toolDrawerId(tool) === id).map(tool => '/tools/' + encodeURIComponent(tool.id));
}
export function toolDrawers(items: VFSNodeUI[], inventory: ToolboxInventory): VFSNodeUI[] {
    const groups = new Map<string, { tool: ToolboxTool; children: VFSNodeUI[] }>();
    for (const item of items) {
        const tool = inventory.tools.get(decodeURIComponent(item.id.slice('/tools/'.length)));
        if (!tool) continue;
        const id = toolDrawerId(tool), group = groups.get(id) ?? { tool, children: [] };
        group.children.push({ ...item, icon: tool.serverId ? TOOLBOX_ICONS.mcp : TOOLBOX_ICONS[id.slice('/tool-groups/'.length) as Category] }); groups.set(id, group);
    }
    return [...groups].map(([id, { tool, children }]) => ({ ...children[0], id, type: 'directory', kind: 'group',
        icon: tool.serverId ? TOOLBOX_ICONS.mcp : TOOLBOX_ICONS[id.slice('/tool-groups/'.length) as Category], content: undefined, children,
        metadata: { ...children[0].metadata, path: id, parentPath: null, tags: [],
            title: tool.serverId ? 'MCP · ' + tool.source : t(`toolbox.category.${id.slice('/tool-groups/'.length) as Category}`),
            custom: { _readOnly: true, toolDrawer: true, navigationDescription: t('toolbox.toolSummary', { count: children.length }) } } }));
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

import { t } from '@itookit/common';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import { resourceIcon } from './resource-icons';
import { toolDrawers } from './tool-drawers';
import { toolboxKind, type ToolboxFilter } from './routes';
import { type Drawer } from '@itookit/app-contracts';
import type { ToolboxDrawers } from '@itookit/app-contracts/services';
import type { ToolboxInventory } from '@itookit/app-contracts/services';

export function resourceDrawers(items: VFSNodeUI[], inventory: ToolboxInventory, groups: ToolboxDrawers, filter: ToolboxFilter): VFSNodeUI[] {
    const files = new Map<string, VFSNodeUI>();
    const collect = (nodes: VFSNodeUI[]): void => { for (const node of nodes) {
        if (node.type === 'file') files.set(node.id, node); else collect(node.children ?? []);
    } };
    collect(items);
    for (const group of toolDrawers(items.filter(item => toolboxKind(item.id) === 'tools'), inventory)) collect(group.children ?? []);
    return groups.snapshot().filter(group => filter === 'all' || filter === group.kind)
        .map(group => drawerNode(group, group.paths.flatMap(id => files.has(id) ? [files.get(id)!] : []), filter === 'all'));
}

function drawerNode(group: Drawer, children: VFSNodeUI[], showKind: boolean): VFSNodeUI {
    return { id: group.id, type: 'directory', kind: 'group', version: '1', icon: group.icon ?? resourceIcon(group.kind), children,
        presentation: { layout: 'drawer' },
        metadata: { title: group.name, path: group.id, parentPath: null, tags: [], createdAt: '', lastModified: '',
            custom: { _readOnly: true, toolboxKind: group.kind, resourceDrawer: true, navigationMenu: true,
                navigationDescription: [showKind ? t(`toolbox.${group.kind}`) : '', t('toolbox.drawerCount', { count: children.length })].filter(Boolean).join(' · ') } } };
}

import { ENTITY_ICONS, t } from '@itookit/common';
import type { ToolboxInventory } from '@itookit/app-contracts/services';
import type { VFSNodeUI } from '@itookit/vfs-ui';

export const invalidConnectionsId = '/invalid-model-connections';

export function invalidConnectionPaths(inventory: ToolboxInventory): string[] {
    return [...inventory.connections].filter(([, connection]) => !inventory.providers.has(connection.providerId))
        .map(([id]) => '/connections/' + encodeURIComponent(id));
}

/** Keep broken references accessible without presenting them as existing providers. */
export function invalidConnectionsDrawer(connections: VFSNodeUI[], inventory: ToolboxInventory): VFSNodeUI[] {
    const paths = new Set(invalidConnectionPaths(inventory));
    const children = connections.filter(item => paths.has(item.id));
    if (!children.length) return [];
    return [{ ...children[0], id: invalidConnectionsId, type: 'directory', kind: 'group', icon: ENTITY_ICONS.model,
        children, content: undefined, presentation: { layout: 'drawer', titleLayout: 'stacked' },
        metadata: { ...children[0].metadata, path: invalidConnectionsId, title: t('toolbox.invalidConnections'), parentPath: null, tags: [],
            custom: { _readOnly: true, modelDrawer: true, modelRank: 3, navigationMenu: true,
                navigationDescription: t('toolbox.invalidConnectionsHint') } } }];
}

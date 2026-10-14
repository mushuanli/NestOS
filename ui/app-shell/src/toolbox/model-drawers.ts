import { providerIcon } from './resource-icons';
import { TOOLBOX_ICONS, t } from '@itookit/common';
import { TOOLBOX_FILTERS } from './routes';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import type { ToolboxInventory } from '@itookit/app-contracts/services';

const prefix = '/model-groups/';
export const modelDrawerId = (providerId: string): string => prefix + encodeURIComponent(providerId);
export const modelDrawerProvider = (path: string): string | undefined => path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : undefined;

/** Display groups keep canonical resource IDs and never relocate configuration files. */
export function modelDrawers(items: VFSNodeUI[], inventory: ToolboxInventory): VFSNodeUI[] {
    const providers = items.filter(item => item.id.startsWith('/providers/'));
    const connections = items.filter(item => item.id.startsWith('/connections/'));
    const groups = new Map(providers.map(item => [decodeURIComponent(item.id.slice('/providers/'.length)), item]));
    for (const item of connections) {
        const providerId = inventory.connections.get(decodeURIComponent(item.id.slice('/connections/'.length)))?.providerId;
        if (providerId && !groups.has(providerId)) groups.set(providerId, item);
    }
    return [...groups].map(([id, seed]) => {
        const provider = inventory.providers.get(id), file = providers.find(item => item.id === '/providers/' + encodeURIComponent(id));
        const children = connections.filter(item => inventory.connections.get(decodeURIComponent(item.id.slice('/connections/'.length)))?.providerId === id);
        const rank = !provider ? 3 : !provider.enabled ? 2 : !provider.configured ? 1 : 0;
        const status = t(!provider ? 'toolbox.providerMissing' : rank === 2 ? 'toolbox.providerDisabled' : rank === 1 ? 'toolbox.providerUnconfigured' : 'toolbox.providerConfigured');
        if (file) children.unshift({ ...file, icon: `<span role="img" aria-label="${t('toolbox.providerSettings')}" title="${t('toolbox.providerSettings')}">${TOOLBOX_ICONS.settings}</span>`, metadata: { ...file.metadata, title: t('toolbox.providerSettings'), tags: [],
            custom: { ...file.metadata.custom, modelSettings: true } }, content: { ...file.content!, searchableText: provider!.name + ' ' + file.content?.searchableText } });
        return { ...seed, id: modelDrawerId(id), type: 'directory', kind: 'group', icon: providerIcon(id, provider?.icon), content: undefined, children,
            presentation: { ...seed.presentation, layout: 'drawer', titleLayout: 'stacked' },
            metadata: { ...seed.metadata, path: modelDrawerId(id), title: provider?.name ?? id, parentPath: null, tags: [],
                custom: { _readOnly: true, modelDrawer: true, navigationMenu: true, modelRank: rank,
                    navigationDescription: t('toolbox.providerSummary', { count: children.length - (file ? 1 : 0), status }) } } };
    });
}

export function compareModelItems(a: VFSNodeUI, b: VFSNodeUI): number | undefined {
    const category = (item: VFSNodeUI) => item.metadata.custom.modelDrawer ? 'models' : item.metadata.custom.toolboxKind;
    const left = TOOLBOX_FILTERS.indexOf(category(a) as never), right = TOOLBOX_FILTERS.indexOf(category(b) as never);
    if (left >= 0 && right >= 0 && left !== right) return left - right;
    if (a.metadata.custom.modelDrawer && b.metadata.custom.modelDrawer)
        return Number(a.metadata.custom.modelRank) - Number(b.metadata.custom.modelRank) || undefined;
    if (!!a.metadata.custom.modelSettings !== !!b.metadata.custom.modelSettings) return a.metadata.custom.modelSettings ? -1 : 1;
    return undefined;
}

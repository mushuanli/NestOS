import { providerIcon } from './resource-icons';
import { isDefaultConnection } from './model-defaults';
import { connectionReadiness } from './model-readiness';
import { TOOLBOX_ICONS, t } from '@itookit/common';
import { TOOLBOX_FILTERS } from './routes';
import {modelIndicators} from './model-indicators';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import type { ToolboxInventory } from '@itookit/app-contracts/services';

const prefix = '/model-groups/';
export const modelDrawerId = (providerId: string): string => prefix + encodeURIComponent(providerId);
export const modelDrawerProvider = (path: string): string | undefined => path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : undefined;

/** Display groups keep canonical resource IDs and never relocate configuration files. */
export function modelDrawers(items: VFSNodeUI[], inventory: ToolboxInventory): VFSNodeUI[] {
    const providers = items.filter(item => item.id.startsWith('/providers/'));
    const connections = items.filter(item => item.id.startsWith('/connections/')).map(item => decorateConnection(item, inventory));
    const groups = new Map(providers.map(item => [decodeURIComponent(item.id.slice('/providers/'.length)), item]));
    for (const item of connections) {
        const providerId = inventory.connections.get(decodeURIComponent(item.id.slice('/connections/'.length)))?.providerId;
        if (providerId && !groups.has(providerId)) groups.set(providerId, item);
    }
    return [...groups].map(([id, seed]) => {
        const provider = inventory.providers.get(id), file = providers.find(item => item.id === '/providers/' + encodeURIComponent(id));
        const children = connections.filter(item => inventory.connections.get(decodeURIComponent(item.id.slice('/connections/'.length)))?.providerId === id);
        const defaultId = [...inventory.connections].find(([connectionId, connection]) => connection.providerId === id && isDefaultConnection(inventory, connectionId))?.[0];
        const isDefault = !!defaultId;
        const rank = drawerRank(id, children, inventory);
        const subscription = provider?.authentication === 'chatgpt';
        const status = t(!provider ? 'toolbox.providerMissing' : !provider.enabled ? 'toolbox.providerDisabled' : subscription
            ? !provider.authorizationAvailable ? 'provider.auth.unsupported' : provider.configured ? 'provider.auth.authorized' : 'provider.auth.signed-out'
            : !provider.configured ? 'toolbox.providerUnconfigured' : 'toolbox.providerConfigured');
        if (file) children.unshift({ ...file, icon: `<span role="img" aria-label="${t('toolbox.providerSettings')}" title="${t('toolbox.providerSettings')}">${TOOLBOX_ICONS.settings}</span>`, metadata: { ...file.metadata, title: t('toolbox.providerSettings'),
            custom: { ...file.metadata.custom, modelSettings: true } }, content: { ...file.content!, searchableText: provider!.name + ' ' + file.content?.searchableText } });
        return { ...seed, id: modelDrawerId(id), type: 'directory', kind: 'group', icon: providerIcon(id, provider?.icon), content: undefined, children,
            presentation: { ...seed.presentation, layout: 'drawer', titleLayout: 'stacked' },
            metadata: { ...seed.metadata, path: modelDrawerId(id), title: (provider?.name ?? id) + (isDefault ? ` · ${t('modelDefaults.default')}` : '') + (subscription ? ` · ${t('provider.auth.subscription')}` : ''), parentPath: null, tags: [],
                custom: { _readOnly: true, modelDrawer: true, navigationMenu: true, modelRank: rank, modelDefault: isDefault,
                    navigationDescription: [isDefault ? connectionReadiness(defaultId!, inventory).label : rank === 2 ? t('connection.status.disabled') : rank === 1 ? t('connection.status.pending') : '', t('toolbox.providerSummary', { count: children.length - (file ? 1 : 0), status })].filter(Boolean).join(' · ') } } };
    });
}

function decorateConnection(item: VFSNodeUI, inventory: ToolboxInventory): VFSNodeUI {
    const id = decodeURIComponent(item.id.slice('/connections/'.length)), status = connectionReadiness(id, inventory);
    const isDefault = isDefaultConnection(inventory, id);
    return {...item, presentation: {...item.presentation, subtitle: undefined, showTags: false, indicators: modelIndicators(inventory.connections.get(id)?.capabilityTags)},
        content: {...item.content!, summary: [status.label, item.content?.summary].filter(Boolean).join(' · ')},
        metadata: {...item.metadata, title: item.metadata.title + (isDefault ? ` · ${t('modelDefaults.default')}` : ''),
            custom: {...item.metadata.custom, modelRank: status.rank, modelDefault: isDefault}}};
}

function drawerRank(id: string, children: VFSNodeUI[], inventory: ToolboxInventory): number {
    const provider = inventory.providers.get(id);
    if (!provider) return 3;
    if (!provider.enabled) return 2;
    if (!provider.configured) return 1;
    if (children.length && children.every(item => Number(item.metadata.custom.modelRank) >= 2)) return 2;
    if (children.length && !children.some(item => item.metadata.custom.modelRank === 0)) return 1;
    return 0;
}

export function compareModelItems(a: VFSNodeUI, b: VFSNodeUI): number | undefined {
    const category = (item: VFSNodeUI) => item.metadata.custom.modelDrawer ? 'models' : item.metadata.custom.toolboxKind;
    const left = TOOLBOX_FILTERS.indexOf(category(a) as never), right = TOOLBOX_FILTERS.indexOf(category(b) as never);
    if (left >= 0 && right >= 0 && left !== right) return left - right;
    if (a.metadata.custom.modelDrawer && b.metadata.custom.modelDrawer)
        return Number(!!b.metadata.custom.modelDefault) - Number(!!a.metadata.custom.modelDefault)
            || Number(a.metadata.custom.modelRank) - Number(b.metadata.custom.modelRank) || undefined;
    if (!!a.metadata.custom.modelSettings !== !!b.metadata.custom.modelSettings) return a.metadata.custom.modelSettings ? -1 : 1;
    if (typeof a.metadata.custom.modelRank === 'number' && typeof b.metadata.custom.modelRank === 'number')
        return a.metadata.custom.modelRank - b.metadata.custom.modelRank || Number(!!b.metadata.custom.modelDefault) - Number(!!a.metadata.custom.modelDefault) || undefined;
    if (category(a) === 'agents' && category(b) === 'agents')
        return Number(b.metadata.custom.executorLastUsed ?? 0) - Number(a.metadata.custom.executorLastUsed ?? 0) || undefined;
    return undefined;
}

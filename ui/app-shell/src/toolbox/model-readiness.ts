import { t } from '@itookit/common';
import type { ToolboxInventory } from '@itookit/app-contracts/services';

export function connectionReadiness(id: string, inventory: ToolboxInventory): {rank: number; label: string} {
    const connection = inventory.connections.get(id), provider = connection && inventory.providers.get(connection.providerId);
    if (!provider || !connection) return {rank: 3, label: t('connection.status.providerMissing')};
    if (!provider.enabled || !connection.enabled) return {rank: 2, label: t('connection.status.disabled')};
    if (!(connection.credentialsReady ?? provider.configured)) return {rank: 1, label: t('connection.credentialsRequired')};
    if ('configuredModel' in connection ? !connection.configuredModel : 'model' in connection && !connection.model)
        return {rank: 1, label: t('toolbox.modelRequired')};
    return {rank: 0, label: t('connection.status.ready')};
}

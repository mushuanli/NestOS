import { t } from '@itookit/common';
import { MODEL_OPERATIONS, type ModelOperation } from '@itookit/kernel-adapters/contracts';
import type { ToolboxInventory, ToolboxResources } from '@itookit/app-contracts/services';
import type { MenuItem } from '@itookit/ui-common';
import type { VFSNodeUI } from '@itookit/vfs-ui';

function defaults(inventory: ToolboxInventory) { return inventory.modelDefaults ?? (inventory.defaultConnectionId ? { chat: inventory.defaultConnectionId } : {}); }
function label(operation: ModelOperation): string { return t(`modelDefaults.purpose.${operation}`); }
export function isDefaultConnection(inventory: ToolboxInventory, connectionId: string): boolean {
    return MODEL_OPERATIONS.some(operation => defaults(inventory)[operation] === connectionId);
}

export function defaultConnectionMenu(id: string, inventory: ToolboxInventory, resources: ToolboxResources): MenuItem<VFSNodeUI>[] {
    const connection = inventory.connections.get(id), provider = connection && inventory.providers.get(connection.providerId);
    return MODEL_OPERATIONS.flatMap(operation => {
        const current = defaults(inventory)[operation] === id;
        const compatible = connection?.operationModels?.[operation] ?? (operation === 'chat' ? connection?.model : undefined);
        if (!current && (!compatible || !connection?.enabled || !provider?.enabled || !(connection.credentialsReady ?? provider.configured))) return [];
        return [{ id: 'default-' + operation, label: t(current ? 'modelDefaults.clear' : 'modelDefaults.set', { purpose: label(operation) }),
            onClick: async () => { await resources.setModelDefault(operation, current ? null : id); } }];
    });
}

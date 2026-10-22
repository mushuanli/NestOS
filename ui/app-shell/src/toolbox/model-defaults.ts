import { t, type NavigationRequest } from '@itookit/common';
import { MODEL_OPERATIONS, type ModelOperation } from '@itookit/kernel-adapters/contracts';
import type { ToolboxInventory, ToolboxResources } from '@itookit/app-contracts/services';
import type { MenuItem } from '@itookit/ui-common';
import type { VFSNodeUI } from '@itookit/vfs-ui';

function defaults(inventory: ToolboxInventory) { return inventory.modelDefaults ?? (inventory.defaultConnectionId ? { chat: inventory.defaultConnectionId } : {}); }
function label(operation: ModelOperation): string { return t(`modelDefaults.purpose.${operation}`); }
export function defaultPurposeLabels(inventory: ToolboxInventory, connectionId: string): string[] {
    return MODEL_OPERATIONS.filter(operation => defaults(inventory)[operation] === connectionId).map(operation => t('modelDefaults.badge', { purpose: label(operation) }));
}

export function updateDefaultShortcuts(root: HTMLElement, inventory: ToolboxInventory,
    navigate: (request: NavigationRequest) => Promise<void>): void {
    root.className = 'toolbox-defaults';
    root.replaceChildren(...MODEL_OPERATIONS.map(operation => {
        const id = defaults(inventory)[operation], connection = id && inventory.connections.get(id);
        const model = connection && (connection.operationModels ? connection.operationModels[operation] : operation === 'chat' ? connection.model : connection.configuredModel);
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = t('modelDefaults.shortcut', { purpose: label(operation), model: model || t('modelDefaults.unset') });
        button.title = t('modelDefaults.configure');
        button.onclick = () => { void navigate({ target: 'settings', resourceId: 'model-defaults', state: { anchor: operation } }); };
        return button;
    }));
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

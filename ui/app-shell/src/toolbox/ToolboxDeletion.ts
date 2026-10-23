import { t } from '@itookit/common';
import { ungroupedId } from '@itookit/app-contracts';
import type { ToolboxResources, ToolboxInventory } from '@itookit/app-contracts/services';
import { createDeleteOperation, type DeleteBatch, type DeletePlan, type VFSNodeUI } from '@itookit/vfs-ui';
import type { IFileSystem } from '@itookit/vfs-core';
import type { ConfigurationDeletionDialog } from '../configuration/delete-dialog';
import { modelDrawerProvider } from './model-drawers';
import { invalidConnectionsId, invalidConnectionPaths } from './model-orphans';
import { toolboxKind, toolboxSourcePath } from './routes';

/** Expand from the catalog, independently of filtering, expansion and lazy rendering. */
export function toolboxSelectionPaths(ids: string[], resources: ToolboxResources, inventory: ToolboxInventory): string[] {
    return ids.flatMap(path => {
        if (path === invalidConnectionsId) return invalidConnectionPaths(inventory);
        const group = resources.drawers.get(path); if (group) return group.paths;
        const provider = modelDrawerProvider(path);
        if (provider === undefined) return [path];
        return [...(inventory.providers.has(provider) ? ['/providers/' + encodeURIComponent(provider)] : []),
            ...[...inventory.connections].filter(([, item]) => item.providerId === provider).map(([id]) => '/connections/' + encodeURIComponent(id))];
    });
}

interface Options {
    resources: ToolboxResources;
    inventory: ToolboxInventory;
    view: IFileSystem;
    deletion: ConfigurationDeletionDialog;
    completed(): Promise<void>;
}

/** Only domain rules live here; the browser owns deletion sequencing. */
export class ToolboxDeletion {
    constructor(private readonly options: Options) {}
    readonly run = createDeleteOperation<string[]>({
        resolve: ids => this.plan(ids),
        confirm: () => Promise.resolve(confirm(t('toolbox.deleteSelectionHint'))),
        completed: () => this.options.completed(),
    });
    allows(items: VFSNodeUI[]): boolean {
        return items.length > 0 && items.every(item => {
            if (item.id === invalidConnectionsId) return true;
            const group = this.options.resources.drawers.get(item.id);
            if (group) return group.kind !== 'tools';
            if (modelDrawerProvider(item.id) !== undefined) return true;
            const kind = toolboxKind(item.id);
            return item.type === 'file' && !!kind && kind !== 'tools'
                && (!item.metadata.custom._readOnly || ['prompts', 'mcp', 'providers', 'connections'].includes(kind));
        });
    }
    private plan(ids: string[]): DeletePlan {
        const { resources, inventory, view } = this.options;
        const paths = toolboxSelectionPaths(ids, resources, inventory);
        const providers = new Set(paths.filter(path => toolboxKind(path) === 'providers').map(path => decodeURIComponent(toolboxSourcePath(path).slice(1))));
        // Provider deletion already owns its linked connections and impact confirmation.
        const independent = paths.filter(path => toolboxKind(path) !== 'connections'
            || !providers.has(inventory.connections.get(decodeURIComponent(toolboxSourcePath(path).slice(1)))?.providerId ?? ''));
        const groups = ids.flatMap(id => resources.drawers.get(id) ?? []).filter(group => group.id !== ungroupedId(group.kind));
        return { resources: [...this.configurationBatches(independent), {
            ids: paths.filter(path => ['agents', 'skills', 'flows'].includes(toolboxKind(path) ?? '')),
            remove: async paths => { await view.driver.delete(paths); return 'completed'; },
        }], containers: groups.map(group => ({ ids: [group.id],
            remove: async () => { await resources.drawers.remove(group); return 'completed'; },
        })) };
    }
    private configurationBatches(paths: string[]): DeleteBatch[] {
        return (['providers', 'connections', 'prompts', 'mcp'] as const).map(kind => ({
            ids: paths.filter(path => toolboxKind(path) === kind),
            remove: (ids, signal) => this.options.deletion.requestResult(ids.map(path => ({ kind: 'entity',
                entityType: kind === 'providers' ? 'provider' : kind === 'connections' ? 'connection' : kind === 'prompts' ? 'system-prompt' : 'mcp',
                id: decodeURIComponent(toolboxSourcePath(path).slice(1)),
            })), signal),
        }));
    }
}

import type {TwinCollectionExecutor, TwinScannerTool} from '@itookit/app-contracts';
import {sha256HexSync} from '@itookit/llm-context';
import type {IToolService} from '@itookit/tools/contracts';
export type CollectionToolCatalog = Pick<IToolService, 'listTools' | 'getToolDefinitions'>;
/** Catalog metadata is safe to project; executable handlers and credentials remain in the Session scope. */
export function collectionTools(catalog: CollectionToolCatalog): TwinScannerTool[] {
    const definitions = catalog.getToolDefinitions();
    return catalog.listTools().filter(meta => meta.enabled && meta.version && meta.sideEffect !== 'external').flatMap(meta => {
        const definition = definitions.find(item => (item.function?.name ?? item.name) === meta.id);
        if (!definition) return [];
        const parameters = definition.function?.parameters ?? definition.parameters ?? {type: 'object', properties: {}};
        return [{name: meta.name || meta.id, description: meta.description, source: meta.type,
            target: {kind: 'tool' as const, id: meta.id, version: meta.version!, digest: sha256HexSync(JSON.stringify([meta, definition]))},
            parameters: structuredClone(parameters) as TwinScannerTool['parameters']}];
    });
}
export function validateCollectionTool(catalog: CollectionToolCatalog, executor: TwinCollectionExecutor): void {
    if (executor.target.kind !== 'tool') return;
    const expected = executor.target;
    if (!collectionTools(catalog).some(item => item.target.id === expected.id && item.target.version === expected.version && item.target.digest === expected.digest))
        throw new Error('TWIN_SCANNER_TARGET_CHANGED');
}

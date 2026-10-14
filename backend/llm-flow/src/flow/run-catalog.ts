import { nodePortSchemas, assertNodePortSchemas } from './node-port-schemas';
import { assertFlowSchema } from './schema-registry';
import type { DagNodeDefinition, DagPluginCatalog, DagPluginManifest, JsonSchemaRef, JsonValue } from '../contracts';

export interface RunCatalogSnapshot {
    manifests: [string, DagPluginManifest | null][];
    schemas: [string, JsonValue | null][];
    localSchemas?: string[];
}

/** Pin metadata durably; executable contributions remain owned by the host catalog. */
export function createRunCatalog(source: DagPluginCatalog, nodes: DagNodeDefinition[], saved?: RunCatalogSnapshot):
    DagPluginCatalog & { snapshot(): RunCatalogSnapshot; addNodes(nodes: DagNodeDefinition[]): void } {
    const manifests = new Map<string, DagPluginManifest | undefined>(saved?.manifests.map(([key, value]) => [key, value ?? undefined]));
    const schemas = new Map<string, JsonValue | undefined>(saved?.schemas.map(([key, value]) => [key, value ?? undefined]));
    const localSchemas = new Set(saved?.localSchemas);
    if (saved) assertCatalogUnchanged(source, saved);
    const getSchema = (ref: JsonSchemaRef): JsonValue | undefined => {
        const key = JSON.stringify([ref.id, ref.version ?? null]);
        if (!schemas.has(key)) schemas.set(key, structuredClone(source.getSchema?.(ref)));
        return structuredClone(schemas.get(key));
    };
    const getManifest = (id: string, version?: string): DagPluginManifest | undefined => {
        const key = JSON.stringify([id, version ?? null]);
        if (!manifests.has(key)) {
            const manifest = structuredClone(source.getManifest(id, version));
            manifests.set(key, manifest);
            for (const port of [...(manifest?.inputs ?? []), ...(manifest?.outputs ?? [])]) {
                if (port.schema) getSchema(port.schema);
            }
        }
        return structuredClone(manifests.get(key));
    };
    const addNodes = (additions: DagNodeDefinition[]): void => {
        additions = additions.flatMap(node => [node, ...dispatchTemplates(node)]);
        for (const node of additions) {
            const ports = nodePortSchemas(node);
            for (const ref of [...Object.values(ports.inputs ?? {}), ...Object.values(ports.outputs ?? {})]) {
                if (ref.definition === undefined) continue;
                assertFlowSchema(ref.definition);
                const key = JSON.stringify([ref.id, ref.version ?? null]);
                const existing = getSchema(ref);
                if (existing !== undefined && canonical(existing) !== canonical(ref.definition)) throw new Error(`Schema definition conflict: ${ref.id}`);
                if (existing === undefined) { schemas.set(key, structuredClone(ref.definition)); localSchemas.add(key); }
            }
        }
        for (const node of additions) {
            getManifest(node.plugin, node.pluginVersion);
            assertNodePortSchemas(node, catalog);
        }
    };
    const catalog = {
        getManifest, getSchema, addNodes,
        snapshot: () => structuredClone({
            manifests: [...manifests].map(([key, value]) => [key, value ?? null]),
            schemas: [...schemas].map(([key, value]) => [key, value ?? null]),
            localSchemas: [...localSchemas],
        }),
        listManifests: () => [...manifests.values()].filter((item): item is DagPluginManifest => !!item).map(item => structuredClone(item)),
        loadRuntime: (id, version) => source.loadRuntime(id, version),
        loadUI: (id, version) => source.loadUI(id, version),
    } satisfies DagPluginCatalog & { snapshot(): RunCatalogSnapshot; addNodes(nodes: DagNodeDefinition[]): void };
    addNodes(nodes);
    return catalog;
}

function dispatchTemplates(node: DagNodeDefinition): DagNodeDefinition[] {
    if (node.plugin !== 'builtin.route' || node.pluginVersion !== '2.0.0') return [];
    const config = node.config as { branches?: { target: DagNodeDefinition }[]; revision?: { invocation?: { target: DagNodeDefinition } } };
    return [...(config?.branches ?? []), ...(config.revision?.invocation ? [config.revision.invocation] : [])].map(branch => {
        if (!branch.target || branch.target.plugin === 'builtin.flow'
            || (branch.target.plugin === 'builtin.route' && branch.target.pluginVersion === '2.0.0')) {
            throw new Error('Invalid or nested dispatch target');
        }
        return branch.target;
    });
}

function assertCatalogUnchanged(source: DagPluginCatalog, saved: RunCatalogSnapshot): void {
    for (const [key, expected] of saved.manifests) {
        const [id, version] = JSON.parse(key) as [string, string | null];
        if (canonical(source.getManifest(id, version ?? undefined) ?? null) !== canonical(expected)) {
            throw new Error(`Flow plugin contract drift: ${id}@${version ?? 'latest'}`);
        }
    }
    for (const [key, expected] of saved.schemas) {
        if (saved.localSchemas?.includes(key)) continue;
        const [id, version] = JSON.parse(key) as [string, string | null];
        if (canonical(source.getSchema?.({ id, ...(version === null ? {} : { version }) }) ?? null) !== canonical(expected)) {
            throw new Error(`Flow schema drift: ${id}@${version ?? '(unversioned)'}`);
        }
    }
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    return JSON.stringify(value);
}

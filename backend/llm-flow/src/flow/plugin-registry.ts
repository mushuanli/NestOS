import { FlowSchemaRegistry } from './schema-registry';
import type { JsonSchemaRef, JsonValue } from '../contracts';
import type { DagPlugin, DagPluginCatalog, DagPluginManifest, DagRuntimeContribution, DagUIContribution } from '../contracts';

export class DagPluginRegistry implements DagPluginCatalog {
    private readonly schemas = new FlowSchemaRegistry();

    registerSchema(ref: JsonSchemaRef, schema: JsonValue): void { this.schemas.register(ref, schema); }
    getSchema(ref: JsonSchemaRef): JsonValue | undefined { return this.schemas.get(ref); }

    private readonly plugins = new Map<string, DagPlugin>();
    private readonly versions = new Map<string, string[]>();

    register(plugin: DagPlugin): void {
        validateManifest(plugin.manifest);
        const key = pluginKey(plugin.manifest.id, plugin.manifest.version);
        if (this.plugins.has(key)) throw new Error(`DAG plugin already registered: ${key}`);
        this.plugins.set(key, { manifest: structuredClone(plugin.manifest),
            runtime: plugin.runtime.bind(plugin), ui: plugin.ui?.bind(plugin) });
        const versions = this.versions.get(plugin.manifest.id) ?? [];
        this.versions.set(plugin.manifest.id, sortVersions([...versions, plugin.manifest.version]));
    }

    listManifests(): DagPluginManifest[] {
        return [...this.plugins.values()]
            .map(plugin => structuredClone(plugin.manifest))
            .sort(compareManifest);
    }

    getManifest(id: string, version?: string): DagPluginManifest | undefined {
        const plugin = this.resolve(id, version);
        return plugin ? structuredClone(plugin.manifest) : undefined;
    }

    async loadRuntime(id: string, version?: string): Promise<DagRuntimeContribution> {
        return this.require(id, version).runtime();
    }

    async loadUI(id: string, version?: string): Promise<DagUIContribution | undefined> {
        return this.require(id, version).ui?.();
    }

    private require(id: string, version?: string): DagPlugin {
        const plugin = this.resolve(id, version);
        if (!plugin) throw new Error(`DAG plugin not found: ${id}@${version ?? 'latest'}`);
        return plugin;
    }

    private resolve(id: string, version?: string): DagPlugin | undefined {
        const resolved = version ?? this.versions.get(id)?.at(-1);
        return resolved ? this.plugins.get(pluginKey(id, resolved)) : undefined;
    }
}

function validateManifest(manifest: DagPluginManifest): void {
    if (!manifest.id || !manifest.version || !manifest.kind) {
        throw new Error('DAG plugin manifest requires id, version and kind');
    }
    JSON.stringify(manifest);
}

function pluginKey(id: string, version: string): string { return `${id}@${version}`; }

function sortVersions(versions: string[]): string[] {
    return [...new Set(versions)].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }));
}

function compareManifest(left: DagPluginManifest, right: DagPluginManifest): number {
    return left.category.localeCompare(right.category)
        || left.title.localeCompare(right.title)
        || left.version.localeCompare(right.version, undefined, { numeric: true });
}

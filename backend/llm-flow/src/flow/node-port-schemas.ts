import type { DagNodeDefinition, DagPluginCatalog, NodePortSchemas, JsonValue } from '../contracts';
import { assertFlowSchema } from './schema-registry';
import { schemaCompatibilityIssue } from './schema-compat';

/** The generated identity is scoped to the node; an explicit result reference may rename it. */
export function nodePortSchemas(node: DagNodeDefinition): NodePortSchemas {
    const declared = structuredClone(node.portSchemas ?? {});
    const config = node.config as { responseFormat?: { type?: string; json_schema?: { name?: string; schema?: JsonValue } } } | null;
    const format = config?.responseFormat;
    if (node.plugin !== 'builtin.agent' || format?.type !== 'json_schema') return declared;
    const json = format.json_schema;
    if (!json?.name?.trim() || json.schema === undefined) throw new Error(`Invalid responseFormat on ${node.id}`);
    const result = declared.outputs?.result;
    return { ...declared, outputs: { ...declared.outputs, result: {
        id: result?.id ?? `agent.response.${node.id}.${json.name}`, version: result?.version ?? '1',
        definition: result?.definition ?? json.schema,
    } } };
}

export function assertNodePortSchemas(node: DagNodeDefinition, plugins: DagPluginCatalog): void {
    const manifest = plugins.getManifest(node.plugin, node.pluginVersion);
    const declared = nodePortSchemas(node);
    for (const direction of ['inputs', 'outputs'] as const) {
        for (const [name, ref] of Object.entries(declared[direction] ?? {})) {
            const port = manifest?.[direction].find(item => item.name === name);
            if (!port) throw new Error(`Unknown ${direction} port ${node.id}.${name}`);
            if (!ref.id?.trim() || (ref.version !== undefined && !ref.version.trim())) throw new Error(`Invalid schema reference ${node.id}.${name}`);
            const schema = plugins.getSchema?.(ref);
            if (schema === undefined) throw new Error(`Unregistered schema ${ref.id}`);
            assertFlowSchema(schema);
            if (port.schema) {
                const base = plugins.getSchema?.(port.schema);
                if (base === undefined || ref.id !== port.schema.id) throw new Error(`Cannot replace plugin contract ${node.id}.${name}`);
                const issue = schemaCompatibilityIssue(schema, base);
                if (issue) throw new Error(`Cannot weaken plugin contract ${node.id}.${name}: ${issue}`);
            }
        }
    }
}

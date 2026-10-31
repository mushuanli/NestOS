import type {TwinScannerTool} from '@itookit/app-contracts';
import type {FormParameter, JsonValue} from '@itookit/llm-ui/forms';

interface Schema {
    type?: string; title?: string; description?: string; default?: JsonValue; const?: JsonValue; enum?: JsonValue[];
    minimum?: number; maximum?: number; required?: string[]; properties?: Record<string, Schema>;
    anyOf?: Schema[]; oneOf?: Schema[];
}
export interface CollectionVariant {key: string; values: JsonValue[]; branches: Schema[]}

/** Recognize a tagged union without interpreting provider-specific resource names. */
export function collectionVariant(tool: TwinScannerTool): CollectionVariant | undefined {
    const schema = tool.parameters as Schema, branches = schema.oneOf ?? schema.anyOf;
    if (!branches || branches.length < 2) return;
    for (const key of Object.keys(branches[0].properties ?? {})) {
        const values = branches.map(branch => singleton(branch.properties?.[key]));
        if (values.some(value => value === undefined) || branches.some(branch => !branch.required?.includes(key))) continue;
        if (new Set(values.map(value => JSON.stringify(value))).size === branches.length) return {key, values: values as JsonValue[], branches};
    }
}
function singleton(schema?: Schema): JsonValue | undefined {
    return schema?.const !== undefined ? schema.const : schema?.enum?.length === 1 ? schema.enum[0] : undefined;
}
export function selectedCollectionBranch(tool: TwinScannerTool, values?: Record<string, JsonValue>): number {
    const variant = collectionVariant(tool);
    if (!variant) return 0;
    const selected = {...tool.defaults, ...values}[variant.key];
    return selected === undefined ? 0 : variant.values.findIndex(value => JSON.stringify(value) === JSON.stringify(selected));
}
export function collectionParameters(tool: TwinScannerTool, index = 0): FormParameter[] {
    const root = tool.parameters as Schema, variant = collectionVariant(tool), branch = variant?.branches[index];
    const properties = {...root.properties, ...branch?.properties}, required = [...root.required ?? [], ...branch?.required ?? []];
    if (!Object.keys(properties).length && (root.anyOf || root.oneOf || root.type !== 'object'))
        return [{name: '$arguments', label: tool.name, type: 'json', required: true, default: tool.defaults ?? {}}];
    return Object.entries(properties).filter(([name]) => name !== variant?.key).map(([name, field]) => parameter(tool, name, field, required.includes(name)));
}
function parameter(tool: TwinScannerTool, name: string, field: Schema, required: boolean): FormParameter {
    const display = tool.presentation?.parameters.find(item => item.name === name);
    return {name, label: display?.label ?? field.title ?? name, description: display?.description ?? field.description,
        type: field.type === 'integer' || field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : field.type === 'string' ? 'string' : 'json',
        integer: field.type === 'integer', minimum: field.minimum, maximum: field.maximum,
        widget: display?.widget, options: display?.widget === 'select' ? display.options : field.enum ?? (field.const !== undefined ? [field.const] : display?.options),
        default: display?.default ?? field.default, required};
}

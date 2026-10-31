import {z} from 'zod/v4';
import type {Tool} from '@itookit/tools';
import type {ToolConnectionView, ToolPackageConfiguration} from '@itookit/app-contracts/services';
import {packageError, type ToolPackageSource} from './manifest';
import {readYamlSidecar, writeYamlSidecar} from './yaml-sidecar';
type FlowParameter = ToolPackageConfiguration['tools'][number]['parameters'][number];

const parameter = z.object({name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/), label: z.string().max(160).optional(), description: z.string().max(2000).optional(), connectionType: z.string().max(100).optional(),
    optionLabels: z.record(z.string().max(160), z.string().max(160)).optional()}).strict();
const toolDisplay = {enableWith: z.string().max(160).optional(), label: z.string().max(160).optional(), hidden: z.boolean().optional(), advanced: z.array(z.string().max(80)).max(100).optional(), parameters: z.array(parameter).max(100)};
const declaration = z.object({version: z.union([z.literal(1), z.literal(2)]), connections: z.record(z.string(), z.array(z.enum(['browser', 'import'])).min(1).max(2)).optional(), preinstall: z.boolean().default(false), tools: z.record(z.string(), z.object(toolDisplay).strict())}).strict();
export type ToolboxDeclaration = z.infer<typeof declaration>;

export async function readToolbox(source: ToolPackageSource): Promise<ToolboxDeclaration | undefined> {
    const value = await readYamlSidecar(source.root, 'toolbox');
    if (value === undefined) return;
    const parsed = declaration.safeParse(value);
    if (!parsed.success || Object.keys(parsed.data.tools).some(id => !source.manifest.tools.some(tool => tool.id === id)))
        throw packageError('TOOL_PACKAGE_TOOLBOX_INVALID', 'Toolbox declarations must name package tools and ordinary default parameters');
    for (const tool of Object.values(parsed.data.tools)) if (new Set(tool.parameters.map(field => field.name)).size !== tool.parameters.length)
        throw packageError('TOOL_PACKAGE_TOOLBOX_INVALID', 'Toolbox parameter names must be unique');
    for (const tool of Object.values(parsed.data.tools)) if (tool.advanced?.some(name => !tool.parameters.some(field => field.name === name)))
        throw packageError('TOOL_PACKAGE_TOOLBOX_INVALID', 'Advanced fields must name declared parameters');
    for (const [id, tool] of Object.entries(parsed.data.tools)) if (tool.enableWith && (id === tool.enableWith || !parsed.data.tools[tool.enableWith] || parsed.data.tools[tool.enableWith].enableWith))
        throw packageError('TOOL_PACKAGE_TOOLBOX_INVALID', 'Compatibility tools must follow one independent tool in the same package');
    return parsed.data;
}
export async function copyToolbox(source: ToolPackageSource, destination: string): Promise<void> {
    const value = await readToolbox(source);
    if (value) await writeYamlSidecar(destination, 'toolbox', value);
}

/** Project only explicitly configurable ordinary fields from the actual Tool schema. */
export function toolboxParameters(tool: Tool, fields: ToolboxDeclaration['tools'][string]['parameters'], connections: ToolConnectionView[] = []): FlowParameter[] {
    const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
    return fields.map(field => {
        const schemas = propertySchemas(schema, field.name);
        if (!schemas.length) throw packageError('TOOL_PACKAGE_TOOLBOX_INVALID', 'Configured default parameter is absent from its Tool schema');
        const value = schemas[0], type = value.type;
        const {connectionType, optionLabels: _labels, ...display} = field;
        const choices = connectionType ? connections.filter(connection => connection.type === connectionType) : [];
        const sameDefault = schemas.every(item => JSON.stringify(item.default) === JSON.stringify(value.default));
        const options = propertyOptions(schemas);
        return {...display, ...(sameDefault && value.default !== undefined ? {default: value.default as never} : {}),
            ...(connectionType ? {widget: 'select' as const, options: choices.map(item => item.id), ...(choices.length === 1 ? {default: choices[0].id} : {})} : {}), type: type === 'number' || type === 'integer' ? 'number' : type === 'boolean' ? 'boolean' : type === 'string' ? 'string' : 'json',
            ...(type === 'integer' ? {integer: true} : {}), ...(options ? {options: options as never[]} : {}),
            ...(typeof value.minimum === 'number' ? {minimum: value.minimum} : {}), ...(typeof value.maximum === 'number' ? {maximum: value.maximum} : {})};
    });
}
function propertyOptions(schemas: Record<string, unknown>[]): unknown[] | undefined {
    const choices = schemas.map(field => Array.isArray(field.enum) ? field.enum : Object.hasOwn(field, 'const') ? [field.const] : undefined);
    if (choices.some(value => !value)) return;
    return [...new Map(choices.flat().map(value => [JSON.stringify(value), value])).values()];
}
export function toolboxOptionLabels(fields: ToolboxDeclaration['tools'][string]['parameters'], connections: ToolConnectionView[]): Record<string, Record<string, string>> {
    return Object.fromEntries(fields.filter(field => field.connectionType || field.optionLabels).map(field => [field.name, field.connectionType
        ? Object.fromEntries(connections.filter(connection => connection.type === field.connectionType).map(connection => [connection.id, connection.name + ' (' + connection.id + ')']))
        : {...field.optionLabels}]));
}
export function validateToolDefaults(tool: Tool, names: string[], values: Record<string, unknown>): void {
    const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
    for (const [name, value] of Object.entries(values)) {
        const fields = propertySchemas(schema, name);
        if (!names.includes(name) || !fields.some(field => z.fromJSONSchema({...field, $defs: schema.$defs} as never).safeParse(value).success))
            throw packageError('TOOL_PACKAGE_DEFAULT_INVALID', `Invalid ordinary default parameter: ${name}`);
    }
}
function propertySchemas(schema: Record<string, unknown>, name: string): Record<string, unknown>[] {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const branches = (schema.anyOf ?? schema.oneOf ?? []) as Record<string, unknown>[];
    return [...(properties?.[name] ? [properties[name]] : []), ...branches.flatMap(branch => propertySchemas(branch, name))];
}

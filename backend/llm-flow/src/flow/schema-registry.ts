import type { JsonSchemaRef, JsonValue } from '../contracts';

type Schema = Record<string, JsonValue>;
const keywords = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'title', 'description', 'minimum', 'maximum']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** An immutable registry for the supported JSON Schema subset; unsupported constraints fail closed. */
export class FlowSchemaRegistry {
    private readonly schemas = new Map<string, JsonValue>();

    register(ref: JsonSchemaRef, schema: JsonValue): void {
        const key = schemaKey(ref);
        if (this.schemas.has(key)) throw new Error(`Schema already registered: ${key}`);
        assertFlowSchema(schema);
        this.schemas.set(key, structuredClone(schema));
    }

    get(ref: JsonSchemaRef): JsonValue | undefined {
        const schema = this.schemas.get(schemaKey(ref));
        return schema === undefined ? undefined : structuredClone(schema);
    }
}

function schemaKey(ref: JsonSchemaRef): string {
    if (typeof ref.id !== 'string' || !ref.id.trim()
        || (ref.version !== undefined && (typeof ref.version !== 'string' || !ref.version.trim()))) {
        throw new Error('Invalid schema reference');
    }
    return JSON.stringify([ref.id, ref.version ?? null]);
}

export function assertFlowSchema(value: JsonValue, path = '$'): asserts value is Schema | boolean {
    if (typeof value === 'boolean') return;
    if (!isObject(value)) throw new Error(`Invalid schema at ${path}`);
    for (const key of Object.keys(value)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword ${path}.${key}`);
    if (value.type !== undefined && (typeof value.type !== 'string' || !types.has(value.type))) throw new Error(`Invalid schema type at ${path}`);
    for (const key of ['title', 'description']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Invalid ${key} at ${path}`);
    for (const key of ['minimum', 'maximum']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new Error(`Invalid ${key} at ${path}`);
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) throw new Error(`Invalid numeric range at ${path}`);
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw new Error(`Invalid enum at ${path}`);
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string'))) throw new Error(`Invalid required at ${path}`);
    if (value.properties !== undefined) {
        if (!isObject(value.properties)) throw new Error(`Invalid properties at ${path}`);
        for (const [key, child] of Object.entries(value.properties)) assertFlowSchema(child, `${path}.properties.${key}`);
    }
    if (value.items !== undefined) assertFlowSchema(value.items, `${path}.items`);
    if (value.additionalProperties !== undefined) assertFlowSchema(value.additionalProperties, `${path}.additionalProperties`);
}

export function flowSchemaIssue(schema: JsonValue, value: unknown, path = '$'): string | undefined {
    assertFlowSchema(schema);
    if (schema === true) return;
    if (schema === false) return `${path}: value is forbidden`;
    if (schema.type && !matchesType(String(schema.type), value)) return `${path}: expected ${schema.type}`;
    if (Array.isArray(schema.enum) && !schema.enum.some(item => equalJson(item, value))) return `${path}: value is outside enum`;
    if (typeof value === 'number' && ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) return `${path}: number outside range`;
    if (isObject(value)) return objectIssue(schema, value, path);
    if (Array.isArray(value) && schema.items !== undefined) {
        for (let i = 0; i < value.length; i++) {
            const issue = flowSchemaIssue(schema.items, value[i], `${path}[${i}]`);
            if (issue) return issue;
        }
    }
}

function objectIssue(schema: Schema, value: Schema, path: string): string | undefined {
    for (const key of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(value, key)) return `${path}.${key}: required`;
    }
    const properties = (schema.properties ?? {}) as Schema;
    for (const [key, item] of Object.entries(value)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
        if (child === undefined) continue;
        const issue = flowSchemaIssue(child, item, `${path}.${key}`);
        if (issue) return issue;
    }
}

function matchesType(type: string, value: unknown): boolean {
    if (type === 'null') return value === null;
    if (type === 'object') return isObject(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

function isObject(value: unknown): value is Schema {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalJson(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i) => equalJson(item, right[i]));
    if (!isObject(left) || !isObject(right)) return false;
    return Object.keys(left).length === Object.keys(right).length
        && Object.keys(left).every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

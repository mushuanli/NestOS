// @file: llm-flow/src/flow/schema-compat.ts
// Structural compatibility for the supported JSON Schema subset.
//
// Ports declare an exact `id@version` contract. When an edge crosses versions of
// the same schema id the registry can still prove the edge safe: the source
// output schema must be a *subtype* of the target input schema, i.e. every value
// valid under the source is valid under the target. Runtime validation
// (`validateDataEdgeValue`) remains authoritative; this is a pre-submit check so
// an incompatible graph fails at publish/patch time instead of mid-run.

import { assertFlowSchema } from './schema-registry';
import type { JsonValue } from '../contracts';

type Schema = Record<string, JsonValue>;
type TypeName = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

/**
 * Supported subset: boolean schemas, `type`, `properties`, `required`,
 * `items`, `additionalProperties` and `enum`. Anything else is rejected by
 * `assertFlowSchema` before this check runs, so compatibility stays decidable.
 *
 * Returns a human-readable issue, or undefined when the source is a subtype.
 */
export function schemaCompatibilityIssue(source: JsonValue, target: JsonValue, path = '$'): string | undefined {
    assertFlowSchema(source, `${path}(source)`);
    assertFlowSchema(target, `${path}(target)`);
    if (target === true) return undefined;
    if (target === false) return source === false ? undefined : `${path}: target forbids all values`;
    if (source === true) return `${path}: source accepts any value`;
    if (source === false) return undefined;

    const enumIssue = enumCompatibility(source, target, path);
    if (enumIssue) return enumIssue;

    const typeIssue = typeCompatibility(source.type, target.type, path);
    if (typeIssue) return typeIssue;

    const rangeIssue = numericCompatibility(source, target, path);
    if (rangeIssue) return rangeIssue;
    const sourceType = source.type as TypeName | undefined;
    const targetType = target.type as TypeName | undefined;
    if (targetType === 'object' || (!targetType && sourceType === 'object')) {
        return objectCompatibility(source, target, path);
    }
    if (targetType === 'array' || (!targetType && sourceType === 'array')) {
        return arrayCompatibility(source, target, path);
    }
    return undefined;
}

function enumCompatibility(source: Schema, target: Schema, path: string): string | undefined {
    const sourceEnum = source.enum as JsonValue[] | undefined;
    const targetEnum = target.enum as JsonValue[] | undefined;
    if (!targetEnum) return undefined;
    if (!sourceEnum) return `${path}: source is not restricted to the target enum`;
    const missing = sourceEnum.filter(value => !targetEnum.some(item => equalJson(item, value)));
    return missing.length ? `${path}: enum value ${JSON.stringify(missing[0])} is not allowed by the target` : undefined;
}

function typeCompatibility(sourceType: unknown, targetType: unknown, path: string): string | undefined {
    if (targetType === undefined) return undefined;
    if (sourceType === targetType) return undefined;
    // integer ⊆ number; every other combination admits values the target rejects.
    if (sourceType === 'integer' && targetType === 'number') return undefined;
    if (sourceType === undefined) return `${path}: source does not restrict the type to ${String(targetType)}`;
    return `${path}: type ${String(sourceType)} is not assignable to ${String(targetType)}`;
}

function objectCompatibility(source: Schema, target: Schema, path: string): string | undefined {
    const sourceProperties = (source.properties ?? {}) as Schema;
    const targetProperties = (target.properties ?? {}) as Schema;

    for (const key of (target.required ?? []) as string[]) {
        if (!((source.required ?? []) as string[]).includes(key)) {
            return `${path}.${key}: required by the target but optional in the source`;
        }
        const sourceChild = propertySchema(source, key);
        if (sourceChild === undefined) return `${path}.${key}: source has no schema for a required target property`;
        const targetChild = propertySchema(target, key);
        if (targetChild === undefined) continue;
        const issue = schemaCompatibilityIssue(sourceChild, targetChild, `${path}.${key}`);
        if (issue) return issue;
    }

    // Extra properties the source may emit must still satisfy the target.
    if (target.additionalProperties === false) {
        const extra = Object.keys(sourceProperties).filter(key => !Object.hasOwn(targetProperties, key));
        if (source.additionalProperties !== false) return `${path}: source may emit additional properties the target forbids`;
        if (extra.length) return `${path}.${extra[0]}: source declares a property the target forbids`;
    } else if (typeof target.additionalProperties === 'object') {
        const sourceAdditional = source.additionalProperties ?? true;
        const issue = schemaCompatibilityIssue(
            sourceAdditional as JsonValue, target.additionalProperties as JsonValue, `${path}.*`,
        );
        if (issue) return issue;
    }
    return undefined;
}

function propertySchema(schema: Schema, key: string): JsonValue | undefined {
    const properties = (schema.properties ?? {}) as Schema;
    if (Object.hasOwn(properties, key)) return properties[key];
    return schema.additionalProperties as JsonValue | undefined;
}

function arrayCompatibility(source: Schema, target: Schema, path: string): string | undefined {
    if (target.items === undefined) return undefined;
    if (source.items === undefined) return `${path}[]: source does not restrict item types`;
    return schemaCompatibilityIssue(source.items, target.items, `${path}[]`);
}

function equalJson(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i) => equalJson(item, right[i]));
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    const a = left as Schema, b = right as Schema;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
}

function numericCompatibility(source: Schema, target: Schema, path: string): string | undefined {
    if (source.type && !['number', 'integer'].includes(String(source.type))) return;
    if (typeof target.minimum === 'number' && (typeof source.minimum !== 'number' || source.minimum < target.minimum)) return `${path}: source minimum is wider than target`;
    if (typeof target.maximum === 'number' && (typeof source.maximum !== 'number' || source.maximum > target.maximum)) return `${path}: source maximum is wider than target`;
}

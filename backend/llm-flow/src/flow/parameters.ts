// @file: llm-flow/src/flow/parameters.ts
// Workflow runtime parameters: template resolution (${params.name}) and
// declared-schema validation. The "framework + variable inputs" split.

import type { FlowParameter, JsonValue } from '../contracts';
import type { ValidationIssue } from './validation';

export function flowParameterValues(schema: FlowParameter[] | undefined, values?: Record<string, JsonValue>): Record<string, JsonValue> {
    const defaults = Object.fromEntries((schema ?? []).filter(param => param.default !== undefined).map(param => [param.name, param.default!]));
    return structuredClone({ ...defaults, ...values });
}

export function prepareFlowParameters(schema: FlowParameter[] | undefined, values?: Record<string, JsonValue>): Record<string, JsonValue> {
    const resolved = flowParameterValues(schema, values);
    const issues = validateFlowParameters(schema, resolved);
    if (issues.length) throw new Error(issues.map(issue => issue.message).join('; '));
    return resolved;
}

/**
 * Deep-resolve `${params.name}` templates inside node config/inputs.
 * A value that is exactly one `${params.name}` keeps the parameter's native
 * type (number/boolean/json); otherwise substrings are replaced as text.
 */
export function resolveFlowParameters(
    value: unknown,
    parameters: Record<string, JsonValue>,
): unknown {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const whole = /^\$\{(?:params|param)\.([A-Za-z0-9_.-]+)\}$/.exec(trimmed);
        if (whole) {
            const resolved = resolveParamPath(parameters, whole[1]);
            if (resolved !== undefined) return resolved;
            return value;
        }
        return value.replace(/\$\{(?:params|param)\.([A-Za-z0-9_.-]+)\}/g, (_match, path: string) => {
            const resolved = resolveParamPath(parameters, path);
            return resolved !== undefined ? stringifyParameter(resolved) : `\${params.${path}}`;
        });
    }
    if (Array.isArray(value)) return value.map(item => resolveFlowParameters(item, parameters));
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [key, resolveFlowParameters(item, parameters)]));
    }
    return value;
}

/** Resolve a dotted parameter path (e.g. `profile.pass_score`) against the flat/nested map. */
function resolveParamPath(parameters: Record<string, JsonValue>, path: string): JsonValue | undefined {
    // Fast path: a top-level key literally named with dots.
    if (path in parameters) return parameters[path];
    const parts = path.split('.');
    let current: JsonValue = parameters;
    for (const part of parts) {
        if (!isRecord(current) || !(part in current)) return undefined;
        current = current[part];
    }
    return current;
}

/** Validate provided values against a workflow's declared parameter schema. */
export function validateFlowParameters(
    schema: FlowParameter[] | undefined,
    values: Record<string, JsonValue> | undefined,
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const provided = flowParameterValues(schema, values);
    for (const param of schema ?? []) {
        const present = param.name in provided && provided[param.name] !== undefined;
        if (param.required && !present) {
            if (param.onMissing !== 'interact') issues.push({ code: 'missing-parameter', message: `Missing required parameter: ${param.name}` });
            continue;
        }
        if (!present) continue;
        if (param.onMissing !== 'interact' && !matchesParameterType(param.type, provided[param.name])) {
            issues.push({ code: 'invalid-parameter', message: `Parameter ${param.name} must be ${param.type}` });
        }
        const value = provided[param.name];
        if (param.onMissing !== 'interact' && typeof value === 'number' && (
            (param.integer && !Number.isInteger(value)) || (param.minimum !== undefined && value < param.minimum)
            || (param.maximum !== undefined && value > param.maximum))) {
            issues.push({ code: 'invalid-parameter', message: `Parameter ${param.name} is outside its numeric constraints` });
        }
    }
    return issues;
}

function matchesParameterType(type: FlowParameter['type'], value: JsonValue): boolean {
    switch (type) {
        case 'string': return typeof value === 'string';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'boolean': return typeof value === 'boolean';
        case 'json': return true;
    }
}

function stringifyParameter(value: JsonValue): string {
    if (value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

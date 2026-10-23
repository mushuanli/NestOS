import type { JsonValue, SerializableExpression } from './flow-definition';

export function evaluateFlowExpression(
    expression: SerializableExpression | undefined,
    value: unknown,
    parameters?: Record<string, JsonValue>,
): boolean {
    if (!expression) return false;
    if (expression.kind === 'literal') return Boolean(expression.value);
    if (expression.kind === 'exists') return resolveFlowExpression(expression.args?.[0], value, parameters) !== undefined;
    if (expression.kind === 'not') return !evaluateFlowExpression(expression.args?.[0], value, parameters);
    if (expression.kind === 'and') return (expression.args ?? []).every(item => evaluateFlowExpression(item, value, parameters));
    if (expression.kind === 'or') return (expression.args ?? []).some(item => evaluateFlowExpression(item, value, parameters));
    if (expression.kind === 'eq') return resolveFlowExpression(expression.args?.[0], value, parameters) === resolveFlowExpression(expression.args?.[1], value, parameters);
    if (expression.kind === 'neq') return resolveFlowExpression(expression.args?.[0], value, parameters) !== resolveFlowExpression(expression.args?.[1], value, parameters);
    if (expression.kind === 'gt') return compare(resolveFlowExpression(expression.args?.[0], value, parameters), resolveFlowExpression(expression.args?.[1], value, parameters)) > 0;
    if (expression.kind === 'gte') return compare(resolveFlowExpression(expression.args?.[0], value, parameters), resolveFlowExpression(expression.args?.[1], value, parameters)) >= 0;
    if (expression.kind === 'lt') return compare(resolveFlowExpression(expression.args?.[0], value, parameters), resolveFlowExpression(expression.args?.[1], value, parameters)) < 0;
    if (expression.kind === 'lte') return compare(resolveFlowExpression(expression.args?.[0], value, parameters), resolveFlowExpression(expression.args?.[1], value, parameters)) <= 0;
    if (expression.kind === 'in') {
        return Array.isArray(expression.value)
            && expression.value.includes(resolveFlowExpression(expression.args?.[0], value, parameters) as JsonValue);
    }
    return resolveFlowExpression(expression, value, parameters) !== undefined;
}

export function resolveFlowExpression(
    expression: SerializableExpression | undefined,
    value: unknown,
    parameters?: Record<string, JsonValue>,
): unknown {
    if (!expression) return undefined;
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'param') return pickParam(parameters, expression.path ?? []);
    if (expression.kind === 'path') return pick(value, expression.path ?? []);
    return ['not', 'and', 'or', 'eq', 'neq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte'].includes(expression.kind)
        ? evaluateFlowExpression(expression, value, parameters) : undefined;
}

function compare(left: unknown, right: unknown): number {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
}

function pickParam(parameters: Record<string, JsonValue> | undefined, path: string[]): unknown {
    return readOwnPath(parameters, path);
}

function readOwnPath(value: unknown, path: string[], parseJson = false): unknown {
    let current = value;
    for (const part of path) {
        // Upstream JSON text is decoded only for input paths, never for parameter literals.
        if (parseJson && typeof current === 'string' && ['{', '['].includes(current.trim()[0])) {
            try { current = JSON.parse(current); } catch { /* keep the raw string */ }
        }
        if (Array.isArray(current)) {
            if (part === 'length') { current = current.length; continue; }
            if (!/^(?:0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) >= current.length) return undefined;
        } else if (!isRecord(current)) return undefined;
        if (!Object.hasOwn(current, part)) return undefined;
        current = Array.isArray(current) ? current[Number(part)] : current[part];
    }
    return current;
}
function pick(value: unknown, path: string[]): unknown {
    const result = readOwnPath(value, path, true);
    return isRecord(result) && Object.hasOwn(result, 'content') ? result.content : result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

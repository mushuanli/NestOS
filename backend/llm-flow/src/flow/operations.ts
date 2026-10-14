import type { DagNodeOutcome, JsonValue, SerializableExpression } from '../contracts';
import { mergeResults } from './structured/results';

export function aggregateOutcome(_config: Record<string, unknown>, inputs: Record<string, unknown>): DagNodeOutcome {
    // Dependency bindings already extract artifact content; keys belong to the caller.
    const previous = inputs.previous ?? {};
    const updates = inputs.updates ?? {};
    if (!isRecord(previous) || !isRecord(updates)) throw new Error('Aggregate inputs must be keyed objects');
    return outcome({ type: 'json' }, mergeResults(previous, updates));
}

export function transformOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
): DagNodeOutcome {
    const source = config.value ?? firstInput(inputs) ?? null;
    const content = config.operation === 'pick' ? pick(source, stringArray(config.path)) : source;
    return outcome(config, content);
}

/** 产出本节点的输出，并附带 patch-graph effect 动态添加节点/边。 */
export function spawnOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
    parentId?: string,
): DagNodeOutcome {
    const base = transformOutcome(config, inputs);
    const spawn = record(config.spawn);
    const patch = {
        idempotencyKey: string(spawn.idempotencyKey, parentId ? `spawn:${parentId}` : 'spawn'),
        nodes: Array.isArray(spawn.nodes) ? spawn.nodes.filter(isRecord) : [],
        edges: Array.isArray(spawn.edges)
            ? spawn.edges.filter(isRecord).map(edge => ({
                ...(edge.id !== undefined ? { id: String(edge.id) } : {}),
                from: resolveSpawnEndpoint(edge.from, parentId),
                to: resolveSpawnEndpoint(edge.to, parentId),
                ...(edge.input !== undefined ? { input: String(edge.input) } : {}),
                ...(edge.output !== undefined ? { output: String(edge.output) } : {}),
                ...(edge.kind === 'control' || edge.kind === 'data' ? { kind: edge.kind } : {}),
                ...(edge.onFailure === 'fail' || edge.onFailure === 'skip' || edge.onFailure === 'continue'
                    ? { onFailure: edge.onFailure }
                    : {}),
            }))
            : [],
    };
    return { ...base, effects: [{ type: 'patch-graph' as const, patch: patch as never }] };
}

function resolveSpawnEndpoint(value: unknown, parentId?: string): string {
    const endpoint = String(value ?? '');
    if (endpoint === '$parent') return parentId ?? endpoint;
    if (endpoint.startsWith('$upstream:')) return endpoint.slice('$upstream:'.length);
    return endpoint;
}

export function reduceOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
): DagNodeOutcome {
    const values = Object.values(inputs).flatMap(value => Array.isArray(value) ? value : [value])
        .map(artifactContent);
    const content = config.type === 'text'
        ? values.map(String).join(string(config.separator, '\n'))
        : values;
    return outcome(config, content);
}

export function routeOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
    parameters?: Record<string, JsonValue>,
): DagNodeOutcome {
    const rules = Array.isArray(config.rules) ? config.rules.filter(isRecord) : [];
    const selected = selectEdges(rules, config, inputs, parameters);
    const defaultEdgeId = typeof config.defaultEdgeId === 'string' ? config.defaultEdgeId : '';
    // 待决定边 = 所有规则边 + 默认边；未选中的一律禁用（含默认边，当规则命中时）。
    const candidates = [...rules.map(rule => String(rule.edgeId ?? '')), defaultEdgeId].filter(Boolean);
    return {
        outputs: { result: { outputName: 'result', type: 'json', content: {
            selectedEdgeIds: selected, selectedValue: rules.find(rule => selected.includes(String(rule.edgeId))
                && evaluate((rule.expression ?? record(rule.condition).expression) as SerializableExpression, inputs, parameters))?.value as JsonValue ?? null,
        } } },
        effects: [
            ...selected.map(edgeId => ({ type: 'activate-edge' as const, edgeId: edgeId as never })),
            ...candidates.filter(id => !selected.includes(id))
                .map(edgeId => ({ type: 'disable-edge' as const, edgeId: edgeId as never })),
        ],
    };
}

function outcome(config: Record<string, unknown>, content: unknown): DagNodeOutcome {
    const outputName = string(config.outputName, 'result');
    return {
        outputs: {
            [outputName]: {
                outputName,
                type: string(config.type, 'json') as 'text' | 'json',
                content: cloneJson(content),
            },
        },
    };
}

function selectEdges(
    rules: Record<string, unknown>[],
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
    parameters?: Record<string, JsonValue>,
): string[] {
    const selected: string[] = [];
    for (const rule of rules.sort(compareRule)) {
        const expression = rule.expression ?? record(rule.condition).expression;
        if (!evaluate(expression as SerializableExpression, inputs, parameters)) continue;
        selected.push(String(rule.edgeId));
        if (config.mode !== 'multicast') break;
    }
    if (!selected.length && config.defaultEdgeId) selected.push(String(config.defaultEdgeId));
    return selected;
}

export function evaluate(
    expression: SerializableExpression | undefined,
    value: unknown,
    parameters?: Record<string, JsonValue>,
): boolean {
    if (!expression) return false;
    if (expression.kind === 'literal') return Boolean(expression.value);
    if (expression.kind === 'exists') return resolve(expression.args?.[0], value, parameters) !== undefined;
    if (expression.kind === 'not') return !evaluate(expression.args?.[0], value, parameters);
    if (expression.kind === 'and') return (expression.args ?? []).every(item => evaluate(item, value, parameters));
    if (expression.kind === 'or') return (expression.args ?? []).some(item => evaluate(item, value, parameters));
    if (expression.kind === 'eq') return resolve(expression.args?.[0], value, parameters) === resolve(expression.args?.[1], value, parameters);
    if (expression.kind === 'neq') return resolve(expression.args?.[0], value, parameters) !== resolve(expression.args?.[1], value, parameters);
    if (expression.kind === 'gt') return compare(resolve(expression.args?.[0], value, parameters), resolve(expression.args?.[1], value, parameters)) > 0;
    if (expression.kind === 'gte') return compare(resolve(expression.args?.[0], value, parameters), resolve(expression.args?.[1], value, parameters)) >= 0;
    if (expression.kind === 'lt') return compare(resolve(expression.args?.[0], value, parameters), resolve(expression.args?.[1], value, parameters)) < 0;
    if (expression.kind === 'lte') return compare(resolve(expression.args?.[0], value, parameters), resolve(expression.args?.[1], value, parameters)) <= 0;
    if (expression.kind === 'in') {
        return Array.isArray(expression.value)
            && expression.value.includes(resolve(expression.args?.[0], value, parameters) as JsonValue);
    }
    return resolve(expression, value, parameters) !== undefined;
}

export function resolve(
    expression: SerializableExpression | undefined,
    value: unknown,
    parameters?: Record<string, JsonValue>,
): unknown {
    if (!expression) return undefined;
    if (expression.kind === 'literal') return expression.value;
    if (expression.kind === 'param') return pickParam(parameters, expression.path ?? []);
    return expression.kind === 'path' ? pick(value, expression.path ?? []) : evaluate(expression, value, parameters);
}

function compare(left: unknown, right: unknown): number {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
}

function pickParam(parameters: Record<string, JsonValue> | undefined, path: string[]): unknown {
    if (!parameters) return undefined;
    let current: JsonValue = parameters;
    for (const part of path) {
        if (!isRecord(current) || !(part in current)) return undefined;
        current = current[part];
    }
    return current;
}

function firstInput(inputs: Record<string, unknown>): unknown {
    return artifactContent(Object.values(inputs)[0]);
}

function artifactContent(value: unknown): unknown {
    return isRecord(value) && 'content' in value ? value.content : value;
}

function pick(value: unknown, path: string[]): unknown {
    let current = value;
    for (const part of path) {
        // Upstream agent nodes emit JSON text; parse it at any nesting level so
        // `path: ['input','score']` can read a field from a `{"score":55}` string.
        if (typeof current === 'string' && current.trim().startsWith('{')) {
            try { current = JSON.parse(current); } catch { /* keep the raw string */ }
        }
        current = record(current)[part];
    }
    return artifactContent(current);
}

function compareRule(left: Record<string, unknown>, right: Record<string, unknown>): number {
    return Number(left.priority ?? 0) - Number(right.priority ?? 0)
        || String(left.edgeId).localeCompare(String(right.edgeId));
}

function string(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function cloneJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; }
